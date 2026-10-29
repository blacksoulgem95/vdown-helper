//! Live recording (HLS live/event playlists, dynamic DASH): the playlist is read again and again and every new segment
//! is appended until the stream ends, the user stops (what was recorded is kept) or cancels (nothing is kept).

use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::time::Duration;

use vdh_core::dash::parse_dash_ref;
use vdh_core::hls::HlsSegment;
use vdh_core::request::DownloadRequest;

use crate::error::{EngineError, Result};
use crate::job::JobContext;
use crate::segments::{SegmentOptions, SegmentProgress, SinkState, write_segments};
use crate::stage::{load_dash_representation, load_media_playlist, now_ms};

pub struct Recorded {
    pub video: PathBuf,
    pub audio: Option<PathBuf>,
    pub duration_sec: f64,
}

/// Segments already written, by address and byte range (a bounded memory of the recent ones).
#[derive(Default)]
struct Seen {
    set: HashSet<String>,
    order: VecDeque<String>,
}

impl Seen {
    fn key(s: &HlsSegment) -> String {
        format!(
            "{}|{}",
            s.uri,
            s.byte_range.map_or(String::new(), |r| r.offset.to_string())
        )
    }

    fn insert(&mut self, s: &HlsSegment) -> bool {
        let k = Self::key(s);
        if !self.set.insert(k.clone()) {
            return false;
        }
        self.order.push_back(k);
        if self.order.len() > 4096 {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// One look at the stream: the segments listed now, whether it has ended, and when to look again.
async fn poll(opts: &SegmentOptions<'_>, url: &str) -> Result<(Vec<HlsSegment>, bool, f64)> {
    if parse_dash_ref(url).is_some() {
        let (segs, _, ended) = load_dash_representation(opts, url, true, now_ms()).await?;
        let seg = segs.last().map_or(2.0, |s| s.duration.max(0.5));
        return Ok((segs, ended, (seg / 2.0).clamp(1.0, 10.0)));
    }
    let p = load_media_playlist(opts, url, true).await?;
    let target = p.target_duration.unwrap_or(2.0);
    Ok((p.segments, p.end_list, (target / 2.0).clamp(1.0, 10.0)))
}

/// Record one track into `path` until the stream ends or `ctx.stop` fires.
async fn record_track(
    ctx: &JobContext,
    url: &str,
    path: &PathBuf,
    progress: &mut (dyn FnMut(SegmentProgress) + Send),
) -> Result<f64> {
    let opts = SegmentOptions {
        net: &ctx.net,
        concurrency: ctx.concurrency,
        tolerate_missing: true,
        cancel: &ctx.cancel,
    };
    let mut out = tokio::fs::File::create(path).await?;
    let mut state = SinkState::default();
    let mut seen = Seen::default();
    let mut written = 0usize;
    loop {
        let (segs, ended, refresh) = poll(&opts, url).await?;
        let fresh: Vec<HlsSegment> = segs.into_iter().filter(|s| seen.insert(s)).collect();
        if !fresh.is_empty() {
            write_segments(&opts, &fresh, &mut out, &mut state, |p| {
                progress(SegmentProgress {
                    done: written + p.done,
                    total: written + p.total,
                    ..p
                });
            })
            .await?;
            written += fresh.len();
        }
        if ended || ctx.stop.is_cancelled() {
            break;
        }
        tokio::select! {
            () = ctx.cancel.cancelled() => return Err(EngineError::cancelled()),
            () = ctx.stop.cancelled() => break,
            () = tokio::time::sleep(Duration::from_secs_f64(refresh)) => {}
        }
    }
    if written == 0 || state.bytes == 0 {
        return Err(EngineError::invalid("Nothing was recorded"));
    }
    Ok(state.seconds)
}

/// Record the request's stream (and its separate audio, in parallel).
pub async fn record(
    req: &DownloadRequest,
    ctx: &JobContext,
    progress: &mut (dyn FnMut(SegmentProgress) + Send),
) -> Result<Recorded> {
    let video = ctx.work_dir.join("video.stream");
    let Some(audio_url) = &req.audio_url else {
        let duration_sec = record_track(ctx, &req.source_url, &video, progress).await?;
        return Ok(Recorded {
            video,
            audio: None,
            duration_sec,
        });
    };
    let audio = ctx.work_dir.join("audio.stream");
    let mut quiet = |_: SegmentProgress| {};
    let (v, a) = tokio::join!(
        record_track(ctx, &req.source_url, &video, progress),
        record_track(ctx, audio_url, &audio, &mut quiet),
    );
    let duration_sec = v?;
    a?;
    Ok(Recorded {
        video,
        audio: Some(audio),
        duration_sec,
    })
}
