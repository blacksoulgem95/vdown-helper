//! Staging: the media of a job fetched to a file on disk (HLS and DASH representations as one concatenated file, plain
//! files streamed), with the DRM checks the extension makes.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use vdh_core::dash::{
    DashParseResult, DashType, expand_segments, main_period_index, parse_dash, parse_dash_ref,
    protections_of,
};
use vdh_core::hls::{HlsMediaPlaylist, HlsParseResult, HlsPlaylist, HlsSegment, parse_hls};

use crate::error::{EngineError, ErrorCode, Result};
use crate::segments::{SegmentOptions, SegmentProgress, SinkState, write_segments};

/// Where a staged track stands, so its job can continue after a pause or a restart instead of starting over.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackCheckpoint {
    /// Segments already in the staging file, in playlist order.
    pub next: usize,
    pub sink: SinkState,
    /// The whole track is staged.
    pub complete: bool,
    pub fragmented: bool,
    pub duration_sec: f64,
}

/// One staged track.
#[derive(Debug, Clone)]
pub struct Staged {
    pub bytes: u64,
    /// fMP4 (an initialisation section and fragments) rather than MPEG-TS.
    pub fragmented: bool,
    pub duration_sec: f64,
}

/// A media playlist, refused when it is protected (DRM or SAMPLE-AES) and, unless `allow_live`, when it has no end.
pub async fn load_media_playlist(
    opts: &SegmentOptions<'_>,
    url: &str,
    allow_live: bool,
) -> Result<HlsMediaPlaylist> {
    let (text, final_url) = opts.net.text(url).await?;
    let p = match parse_hls(&text, &final_url) {
        HlsParseResult::Ok {
            playlist: HlsPlaylist::Media(p),
            ..
        } => p,
        HlsParseResult::Ok { .. } => return Err(EngineError::invalid("Expected a media playlist")),
        HlsParseResult::Err { error, .. } => {
            return Err(EngineError::invalid(format!(
                "Playlist error: {:?}",
                error.code
            )));
        }
    };
    if p.has_drm {
        return Err(EngineError::protected(
            "This stream uses DRM or SAMPLE-AES encryption, which is not supported",
        ));
    }
    if !p.end_list && !allow_live {
        return Err(EngineError::invalid(
            "Live streams cannot be downloaded; record them instead",
        ));
    }
    Ok(p)
}

/// The segments of one DASH representation (`<manifest>#vdh-rep=<id>`), with its initialisation section as the map of
/// every segment. Encrypted representations are refused (ClearKey included: CENC is not decrypted here either).
pub async fn load_dash_representation(
    opts: &SegmentOptions<'_>,
    reference: &str,
    allow_live: bool,
    now_ms: f64,
) -> Result<(Vec<HlsSegment>, f64, bool)> {
    let r = parse_dash_ref(reference)
        .ok_or_else(|| EngineError::invalid("Not a DASH representation reference"))?;
    let (text, final_url) = opts.net.text(&r.manifest_url).await?;
    let m = match parse_dash(&text, &final_url) {
        DashParseResult::Ok { manifest, .. } => manifest,
        DashParseResult::Err { error, .. } => {
            return Err(EngineError::invalid(format!(
                "Manifest error: {:?}",
                error.code
            )));
        }
    };
    let dynamic = m.kind == DashType::Dynamic;
    if dynamic && !allow_live {
        return Err(EngineError::invalid(
            "Live streams cannot be downloaded; record them instead",
        ));
    }
    let period = m
        .periods
        .get(main_period_index(&m))
        .ok_or_else(|| EngineError::invalid("The manifest has no period"))?;
    let rep = period
        .representations
        .iter()
        .find(|x| x.id == r.rep_id)
        .ok_or_else(|| {
            EngineError::invalid("The representation no longer exists in the manifest")
        })?;
    let scope: Vec<_> = if rep.content == vdh_core::dash::DashContent::Text {
        vec![rep.clone()]
    } else {
        period.representations.clone()
    };
    let prot = protections_of(&scope);
    if prot.drm || prot.clear_key {
        return Err(EngineError::protected(
            "This stream is encrypted and cannot be downloaded",
        ));
    }
    let x = expand_segments(&m, period, rep, now_ms).map_err(EngineError::invalid)?;
    let segs = x
        .segments
        .into_iter()
        .map(|mut s| {
            if s.map.is_none() {
                s.map.clone_from(&x.init);
            }
            s
        })
        .collect();
    Ok((segs, x.duration_sec, !dynamic))
}

/// The milliseconds since the epoch (the clock of a dynamic manifest).
pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// An HLS media playlist or a DASH representation, fetched into `path`. With a checkpoint the staging file is cut back
/// to what the checkpoint vouches for and the segments after it are fetched; `progress` reports a checkpoint after every
/// segment written.
pub async fn stage_stream(
    opts: &SegmentOptions<'_>,
    url: &str,
    dash: bool,
    path: &Path,
    from: Option<&TrackCheckpoint>,
    mut progress: impl FnMut(SegmentProgress, &TrackCheckpoint),
) -> Result<Staged> {
    if let Some(cp) = from.filter(|c| c.complete) {
        if tokio::fs::metadata(path)
            .await
            .is_ok_and(|m| m.len() >= cp.sink.bytes)
        {
            return Ok(Staged {
                bytes: cp.sink.bytes,
                fragmented: cp.fragmented,
                duration_sec: cp.duration_sec,
            });
        }
    }
    let (segs, duration_sec, fragmented) = if dash {
        let (segs, d, _) = load_dash_representation(opts, url, false, now_ms()).await?;
        (segs, d, true)
    } else {
        let p = load_media_playlist(opts, url, false).await?;
        (p.segments, p.total_duration, p.fragmented)
    };
    if segs.is_empty() {
        return Err(EngineError::invalid("The stream has no segments"));
    }
    // continue only from a checkpoint that fits this playlist and a file that holds what it vouches for
    let have = tokio::fs::metadata(path).await.map_or(0, |m| m.len());
    let resume =
        from.filter(|c| !c.complete && c.next <= segs.len() && c.sink.bytes <= have && c.next > 0);
    let (mut out, mut state, start) = match resume {
        Some(cp) => {
            let mut f = tokio::fs::OpenOptions::new().write(true).open(path).await?;
            f.set_len(cp.sink.bytes).await?;
            f.seek(std::io::SeekFrom::End(0)).await?;
            (f, cp.sink.clone(), cp.next)
        }
        None => (
            tokio::fs::File::create(path).await?,
            SinkState::default(),
            0,
        ),
    };
    let total = segs.len();
    write_segments(opts, &segs[start..], &mut out, &mut state, |p| {
        let cp = TrackCheckpoint {
            next: start + p.done,
            sink: p.state.clone(),
            complete: false,
            fragmented,
            duration_sec,
        };
        progress(
            SegmentProgress {
                done: start + p.done,
                total,
                ..p
            },
            &cp,
        );
    })
    .await?;
    let done = TrackCheckpoint {
        next: total,
        sink: state.clone(),
        complete: true,
        fragmented,
        duration_sec,
    };
    progress(
        SegmentProgress {
            done: total,
            total,
            bytes: state.bytes,
            state: state.clone(),
        },
        &done,
    );
    Ok(Staged {
        bytes: state.bytes,
        fragmented,
        duration_sec,
    })
}

/// A plain file streamed into `path`, resuming after the bytes already there when the server allows it.
pub async fn stage_file(
    opts: &SegmentOptions<'_>,
    url: &str,
    path: &Path,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<u64> {
    let have = tokio::fs::metadata(path).await.map_or(0, |m| m.len());
    let res = opts
        .net
        .get(url, (have > 0).then_some((have, None)))
        .await?;
    let resumed = have > 0 && res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let mut out = if resumed {
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(path)
            .await?
    } else {
        tokio::fs::File::create(path).await?
    };
    let mut written = if resumed { have } else { 0 };
    let total = res.content_length().map(|n| n + written);
    let mut res = res;
    loop {
        let chunk = tokio::select! {
            () = opts.cancel.cancelled() => return Err(EngineError::cancelled()),
            c = res.chunk() => c.map_err(|_| EngineError::new(ErrorCode::Network, "The connection failed"))?,
        };
        let Some(chunk) = chunk else { break };
        opts.net.throttle(chunk.len()).await;
        out.write_all(&chunk).await?;
        written += chunk.len() as u64;
        progress(written, total);
    }
    out.flush().await?;
    if total.is_some_and(|t| t != written) {
        return Err(EngineError::new(
            ErrorCode::Network,
            "The download ended early",
        ));
    }
    Ok(written)
}
