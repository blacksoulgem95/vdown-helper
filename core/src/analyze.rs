//! Downloadability verdicts (`src/lib/analyze.ts`): what a parsed playlist or manifest means for the user. These are
//! the decisions that refuse DRM, so the extension and the desktop app share them.

use serde::Serialize;

use crate::dash::{
    DashContent, DashErrorCode, DashParseResult, DashType, dash_ref, expand_segments,
    main_period_index, parse_dash, period_duration, protections_of,
};
use crate::hls::{HlsMediaPlaylist, HlsRendition, HlsVariant, KeyMethod, RenditionType};
use crate::js;
use crate::media::estimate_bytes;

const MAX_VARIANTS: usize = 50;
const MAX_AUDIO_TRACKS: usize = 50;
const MAX_SUBTITLE_TRACKS: usize = 30;
const MAX_TEXT: usize = 200;

fn clip(s: &str) -> String {
    if js::len_utf16(s) > MAX_TEXT {
        format!("{}…", js::slice_utf16(s, MAX_TEXT))
    } else {
        s.to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Downloadability {
    pub status: &'static str,
    pub reason: &'static str,
    /// Short, non-sensitive detail for the technical-details view (never contains URLs with tokens).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn verdict(status: &'static str, reason: &'static str, detail: Option<&str>) -> Downloadability {
    Downloadability {
        status,
        reason,
        detail: detail.map(str::to_string),
    }
}

/// Verdict for a parsed media playlist.
pub fn media_playlist_verdict(p: &HlsMediaPlaylist) -> Downloadability {
    if p.has_drm {
        let sample = p
            .encryption
            .iter()
            .any(|m| matches!(m, KeyMethod::SampleAes | KeyMethod::SampleAesCtr));
        return verdict("protected", if sample { "sample-aes" } else { "drm" }, None);
    }
    // A stream that is still being made cannot be downloaded, but it can be recorded as it goes by.
    if !p.end_list {
        return verdict("downloadable", "ok", Some("live-recordable"));
    }
    if p.encryption.contains(&KeyMethod::Aes128) {
        return verdict("downloadable", "ok", Some("aes-128"));
    }
    verdict("downloadable", "ok", None)
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistSummary {
    pub playlist_class: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segment_count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live: Option<bool>,
    pub encryption: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fragmented: Option<bool>,
    /// DASH: number of periods in the manifest (only the longest, the main content, is downloaded).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub periods: Option<f64>,
}

/// The fields of a resource that a DASH manifest decides (`dashResource`); absent fields are left as they were.
#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DashResourcePatch {
    pub format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playlist: Option<PlaylistSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloadability: Option<Downloadability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variants: Option<Vec<HlsVariant>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_tracks: Option<Vec<HlsRendition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle_tracks: Option<Vec<HlsRendition>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codecs: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_is_estimate: Option<bool>,
}

fn has_audio_codec(codecs: Option<&str>) -> bool {
    let c = codecs.unwrap_or("").to_lowercase();
    ["mp4a", "ac-3", "ec-3", "opus", "vorbis", "flac"]
        .iter()
        .any(|a| c.contains(a))
}

fn error_code(code: DashErrorCode) -> &'static str {
    match code {
        DashErrorCode::Malformed => "malformed",
        DashErrorCode::NotDash => "not-dash",
        DashErrorCode::UnsafeUrl => "unsafe-url",
        DashErrorCode::Empty => "empty",
    }
}

/// Describe an MPEG-DASH manifest: its real representations, duration, protection and addressing.
pub fn dash_resource(text: &str, url: &str) -> DashResourcePatch {
    let mut r = DashResourcePatch {
        format: "dash",
        ..DashResourcePatch::default()
    };
    let m = match parse_dash(text, url) {
        DashParseResult::Ok { manifest, .. } => manifest,
        DashParseResult::Err { error, .. } => {
            r.kind = Some("unsupported-playlist");
            r.playlist = Some(PlaylistSummary {
                playlist_class: "dash",
                ..PlaylistSummary::default()
            });
            r.downloadability = Some(if error.code == DashErrorCode::UnsafeUrl {
                verdict("unsupported", "unsafe-url", None)
            } else {
                verdict("unsupported", "malformed", Some(error_code(error.code)))
            });
            return r;
        }
    };
    let Some(period) = m.periods.get(main_period_index(&m)) else {
        r.kind = Some("unsupported-playlist");
        r.downloadability = Some(verdict("unsupported", "malformed", None));
        return r;
    };
    r.kind = Some("dash");
    let mut videos: Vec<_> = period
        .representations
        .iter()
        .filter(|x| x.content == DashContent::Video)
        .collect();
    videos.sort_by(|a, b| {
        let dh = b.height.unwrap_or(0.0) - a.height.unwrap_or(0.0);
        let d = if dh != 0.0 {
            dh
        } else {
            b.bandwidth - a.bandwidth
        };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    videos.truncate(MAX_VARIANTS);
    let audios: Vec<_> = period
        .representations
        .iter()
        .filter(|x| x.content == DashContent::Audio)
        .take(MAX_AUDIO_TRACKS)
        .collect();
    let variants: Vec<HlsVariant> = videos
        .iter()
        .map(|x| HlsVariant {
            uri: dash_ref(url, &x.id),
            bandwidth: x.bandwidth,
            average_bandwidth: None,
            width: x.width.filter(|w| *w != 0.0),
            height: x.height.filter(|h| *h != 0.0),
            frame_rate: x.frame_rate.filter(|f| *f != 0.0),
            codecs: x.codecs.clone().filter(|c| !c.is_empty()),
            video_range: None,
            // Separate audio is only offered for video that does not already carry it.
            audio_group: (!audios.is_empty() && !has_audio_codec(x.codecs.as_deref()))
                .then(|| "dash-audio".into()),
            subtitle_group: None,
        })
        .collect();
    let track = |x: &crate::dash::DashRepresentation| {
        clip(x.label.as_deref().or(x.lang.as_deref()).unwrap_or(&x.id))
    };
    r.audio_tracks = Some(
        audios
            .iter()
            .enumerate()
            .map(|(i, x)| HlsRendition {
                kind: RenditionType::Audio,
                group_id: "dash-audio".into(),
                name: track(x),
                language: x.lang.clone().filter(|l| !l.is_empty()),
                uri: Some(dash_ref(url, &x.id)),
                is_default: i == 0,
                auto_select: true,
                channels: None,
                codecs: x.codecs.clone().filter(|c| !c.is_empty()),
            })
            .collect(),
    );
    let texts: Vec<_> = period
        .representations
        .iter()
        .filter(|x| x.content == DashContent::Text)
        .take(MAX_SUBTITLE_TRACKS)
        .collect();
    if m.kind == DashType::Static && !texts.is_empty() {
        r.subtitle_tracks = Some(
            texts
                .iter()
                .map(|x| HlsRendition {
                    kind: RenditionType::Subtitles,
                    group_id: "dash-text".into(),
                    name: track(x),
                    language: x.lang.clone().filter(|l| !l.is_empty()),
                    uri: Some(dash_ref(url, &x.id)),
                    is_default: false,
                    auto_select: false,
                    channels: None,
                    // The codec decides whether the track can be read (wvtt/image tracks cannot), the MIME type is the
                    // fallback.
                    codecs: Some(x.codecs.clone().unwrap_or_else(|| x.mime_type.clone()))
                        .filter(|c| !c.is_empty()),
                })
                .collect(),
        );
    }
    r.media_type = Some(if videos.is_empty() { "audio" } else { "video" });
    if let Some(top) = variants.first() {
        r.bitrate = Some(top.average_bandwidth.unwrap_or(top.bandwidth));
        r.width = top.width;
        r.height = top.height;
        r.frame_rate = top.frame_rate;
        r.codecs = top.codecs.clone();
    }
    r.variants = Some(variants);
    if videos.is_empty()
        && let Some(a) = audios.first()
    {
        r.bitrate = Some(a.bandwidth);
    }
    let dur = period_duration(&m, period);
    r.duration_sec = dur;

    let top = videos.first().or(audios.first()).copied();
    let mut segment_count = None;
    if let (Some(top), DashType::Static) = (top, m.kind) {
        // The clock only matters for dynamic manifests.
        match expand_segments(&m, period, top, 0.0) {
            Ok(e) => segment_count = Some(e.segments.len() as f64),
            Err(_) => {
                r.downloadability = Some(verdict("unsupported", "malformed", Some("segments")));
                r.playlist = Some(PlaylistSummary {
                    playlist_class: "dash",
                    periods: Some(m.periods.len() as f64),
                    ..PlaylistSummary::default()
                });
                return r;
            }
        }
    }
    r.playlist = Some(PlaylistSummary {
        playlist_class: "dash",
        segment_count,
        encryption: Vec::new(),
        fragmented: Some(true),
        live: Some(m.kind == DashType::Dynamic),
        periods: Some(m.periods.len() as f64),
        target_duration: None,
    });
    let prot = protections_of(&period.representations);
    r.downloadability = Some(if prot.drm {
        let systems: Vec<&str> = prot.systems.iter().map(|s| s.as_str()).collect();
        verdict("protected", "drm", Some(&systems.join(",")))
    } else if prot.clear_key {
        // Encrypted with ClearKey: only downloadable once its key can be obtained (not implemented yet).
        verdict("unsupported", "dash-clearkey", None)
    } else if m.kind == DashType::Dynamic {
        if top.is_some() {
            verdict("downloadable", "ok", Some("live-recordable"))
        } else {
            verdict("unsupported", "no-segments", None)
        }
    } else if top.is_none() {
        verdict("unsupported", "no-segments", None)
    } else {
        if let Some(size) = estimate_bytes(r.bitrate, dur) {
            r.size_bytes = Some(size);
            r.size_is_estimate = Some(true);
        }
        verdict("downloadable", "ok", None)
    });
    r
}
