//! The output planner (`src/lib/compat.ts`): decides how a request is fulfilled and whether it is allowed. In the
//! extension video is never re-encoded (stream copy only); audio may be transcoded; FFmpeg is only required when the
//! result cannot be produced by a native download or byte concatenation.

use serde::{Deserialize, Serialize};

use crate::media::is_audio_only_format;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_memory_mb: f64,
    pub max_encode_duration_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub is_hls: bool,
    /// For HLS: true when segments are fMP4 (init map), false for MPEG-TS.
    #[serde(default)]
    pub fragmented: Option<bool>,
    pub source_format: String,
    #[serde(default)]
    pub video_family: Option<String>,
    #[serde(default)]
    pub audio_family: Option<String>,
    /// The variant playlist carries audio itself (no separate rendition required).
    pub has_muxed_audio: bool,
    /// A separate audio rendition has been selected.
    pub separate_audio: bool,
    /// The source stream has a video track at all.
    pub has_video: bool,
    pub mode: String,
    pub container: String,
    pub audio_format: String,
    pub audio_bitrate: f64,
    #[serde(default)]
    pub estimated_bytes: Option<f64>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub live: Option<bool>,
    #[serde(default)]
    pub protected_stream: Option<bool>,
    pub limits: Limits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub valid: bool,
    pub issues: Vec<String>,
    pub pipeline: String,
    pub requires_ffmpeg: bool,
    /// Per-track handling, only meaningful when valid: copy | transcode | none.
    pub video: String,
    pub audio: String,
    /// The target container/extension of the produced file.
    pub extension: String,
    /// Whether an audio bitrate choice affects the result.
    pub uses_bitrate: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub warnings: Option<Vec<String>>,
}

impl Plan {
    pub(crate) fn new(pipeline: &str, video: &str, audio: &str, extension: &str) -> Self {
        Self {
            valid: false,
            issues: Vec::new(),
            pipeline: pipeline.into(),
            requires_ffmpeg: false,
            video: video.into(),
            audio: audio.into(),
            extension: extension.into(),
            uses_bitrate: false,
            warnings: None,
        }
    }
}

fn known(family: Option<&str>) -> Option<&str> {
    family.filter(|f| !f.is_empty() && *f != "unknown")
}

/// Whether a video stream can be placed in `container` without re-encoding. Unknown codec = assume yes.
pub fn video_fits_container(family: Option<&str>, container: &str) -> bool {
    let Some(f) = known(family) else { return true };
    match container {
        "mkv" => true,
        "mp4" => matches!(f, "h264" | "hevc" | "av1" | "vp9" | "mpeg4"),
        _ => matches!(f, "h264" | "hevc" | "mpeg4"),
    }
}

pub fn audio_fits_container(family: Option<&str>, container: &str) -> bool {
    let Some(f) = known(family) else { return true };
    match container {
        "mkv" => true,
        "mp4" => matches!(f, "aac" | "mp3" | "ac3" | "eac3" | "opus" | "flac"),
        _ => matches!(f, "aac" | "mp3" | "ac3" | "eac3"),
    }
}

/// Containers a plain file of this format may be copied into without re-encoding its video. Legacy formats usually hold
/// codecs MP4 cannot carry, so those are only offered as a Matroska copy or kept as they are.
pub fn source_fits_container(format: &str, container: &str) -> bool {
    let allowed: &[&str] = match format {
        "flv" => &["mp4", "mkv", "ts"],
        "avi" | "wmv" | "asf" => &["mkv"],
        "mpg" => &["mkv", "ts"],
        "3gp" => &["mp4", "mkv"],
        _ => return true,
    };
    allowed.contains(&container)
}

/// File extension for a source format. Unknown sources get none: Chrome names them from the response instead.
pub fn file_extension(format: &str) -> String {
    if matches!(format, "unknown" | "blob" | "m3u" | "dash") {
        String::new()
    } else {
        format.to_string()
    }
}

pub fn audio_extension(format: &str) -> String {
    format.to_string()
}

pub fn plan_output(i: &PlanInput) -> Plan {
    let mut issues: Vec<String> = Vec::new();
    let base = Plan::new("native", "none", "none", "");
    let fragmented = i.fragmented == Some(true);
    if i.protected_stream == Some(true) {
        issues.push("protected".into());
    }
    if i.is_hls && i.live == Some(true) {
        issues.push("live-stream".into());
    }
    if matches!(i.source_format.as_str(), "dash" | "m3u" | "blob") {
        issues.push("unsupported-source".into());
    }
    let fail = |issues: Vec<String>| Plan {
        issues,
        ..base.clone()
    };
    if !issues.is_empty() {
        return fail(issues);
    }
    let vf = i.video_family.as_deref();
    let af = i.audio_family.as_deref();

    let source_is_audio_file = !i.is_hls && is_audio_only_format(&i.source_format);
    let has_audio_track =
        i.has_muxed_audio || i.separate_audio || source_is_audio_file || (!i.is_hls && i.has_video);

    // ---- Audio only
    if i.mode == "audio-only" {
        if !has_audio_track {
            return fail(vec!["no-audio-source".into()]);
        }
        let copyable = af == Some("aac") && (i.audio_format == "m4a" || i.audio_format == "aac");
        let already_that_file = source_is_audio_file && i.source_format == i.audio_format;
        let transcode = !copyable;
        let pipeline = if already_that_file {
            "native"
        } else if transcode {
            "ffmpeg-transcode"
        } else if i.is_hls {
            "hls-ffmpeg-copy"
        } else {
            "file-ffmpeg-copy"
        };
        let plan = Plan {
            requires_ffmpeg: !already_that_file,
            pipeline: pipeline.into(),
            audio: (if already_that_file || copyable {
                "copy"
            } else {
                "transcode"
            })
            .into(),
            extension: audio_extension(&i.audio_format),
            uses_bitrate: !already_that_file && transcode && i.audio_format != "wav",
            ..base.clone()
        };
        return finalize(plan, i);
    }

    // ---- An audio-only source kept as it is (an .mp3 link, an audio-only HLS rendition): nothing to convert.
    if !i.has_video && i.mode == "original" {
        if !has_audio_track {
            return fail(vec!["no-audio-source".into()]);
        }
        let plan = if i.is_hls {
            Plan {
                pipeline: "hls-concat".into(),
                audio: "copy".into(),
                extension: (if fragmented { "m4a" } else { "ts" }).into(),
                ..base.clone()
            }
        } else {
            Plan {
                pipeline: "native".into(),
                audio: "copy".into(),
                extension: file_extension(&i.source_format),
                ..base.clone()
            }
        };
        return finalize(plan, i);
    }

    if !i.has_video {
        return fail(vec!["no-video-source".into()]);
    }

    // ---- Video only
    if i.mode == "video-only" {
        let needs_remux = i.container != "original";
        let target = (i.container != "original").then_some(i.container.as_str());
        if let Some(t) = target {
            if !video_fits_container(vf, t) {
                issues.push("video-codec-container".into());
            }
            if !i.is_hls && !source_fits_container(&i.source_format, t) {
                issues.push("video-codec-container".into());
            }
        }
        if !issues.is_empty() {
            return fail(issues);
        }
        let ext = match target {
            Some(t) => t.to_string(),
            None if i.is_hls => (if fragmented { "mp4" } else { "ts" }).to_string(),
            None => file_extension(&i.source_format),
        };
        // Muxed sources need FFmpeg to drop the audio; a native download would keep it.
        let must_strip_audio = i.has_muxed_audio || (!i.is_hls && !source_is_audio_file);
        let ffmpeg = needs_remux || must_strip_audio;
        let pipeline = if ffmpeg {
            if i.is_hls {
                "hls-ffmpeg-copy"
            } else {
                "file-ffmpeg-copy"
            }
        } else {
            "native"
        };
        return finalize(
            Plan {
                requires_ffmpeg: ffmpeg,
                pipeline: pipeline.into(),
                video: "copy".into(),
                audio: "none".into(),
                extension: ext,
                ..base.clone()
            },
            i,
        );
    }

    // ---- Original quality / Video + audio
    let wants_original = i.container == "original";
    let merge_needed = (i.mode == "video-audio" || i.mode == "original") && i.separate_audio;

    if wants_original && !merge_needed {
        // Preserve the source container: nothing is re-encoded.
        let ext = if i.is_hls {
            (if fragmented { "mp4" } else { "ts" }).to_string()
        } else {
            file_extension(&i.source_format)
        };
        return finalize(
            Plan {
                pipeline: (if i.is_hls { "hls-concat" } else { "native" }).into(),
                video: "copy".into(),
                audio: (if i.has_muxed_audio || !i.is_hls {
                    "copy"
                } else {
                    "none"
                })
                .into(),
                extension: ext,
                ..base.clone()
            },
            i,
        );
    }

    // "Original" with a merge: MP4 when both codecs fit it (widest compatibility), otherwise Matroska.
    let target = if i.container == "original" {
        if video_fits_container(vf, "mp4") && audio_fits_container(af, "mp4") {
            "mp4"
        } else {
            "mkv"
        }
    } else {
        i.container.as_str()
    };
    if !video_fits_container(vf, target) {
        issues.push("video-codec-container".into());
    }
    if !i.is_hls && !source_fits_container(&i.source_format, target) {
        issues.push("video-codec-container".into());
    }
    let audio_ok = audio_fits_container(af, target);
    // "Original quality" promises no re-encoding at all, so a mismatching audio codec is refused rather than converted.
    if !audio_ok && i.mode == "original" {
        issues.push("audio-codec-container".into());
    }
    if !issues.is_empty() {
        return fail(issues);
    }
    let transcode_audio = !audio_ok && (i.has_muxed_audio || i.separate_audio || !i.is_hls);

    if !i.is_hls && i.source_format == target && !merge_needed {
        return finalize(
            Plan {
                pipeline: "native".into(),
                video: "copy".into(),
                audio: "copy".into(),
                extension: target.into(),
                ..base.clone()
            },
            i,
        );
    }
    if i.is_hls && !merge_needed && !transcode_audio && target == "ts" && !fragmented {
        return finalize(
            Plan {
                pipeline: "hls-concat".into(),
                video: "copy".into(),
                audio: (if i.has_muxed_audio { "copy" } else { "none" }).into(),
                extension: "ts".into(),
                ..base.clone()
            },
            i,
        );
    }
    let pipeline = if transcode_audio {
        "ffmpeg-transcode"
    } else if i.is_hls {
        "hls-ffmpeg-copy"
    } else {
        "file-ffmpeg-copy"
    };
    let audio = if i.has_muxed_audio || i.separate_audio || !i.is_hls {
        if transcode_audio { "transcode" } else { "copy" }
    } else {
        "none"
    };
    finalize(
        Plan {
            requires_ffmpeg: true,
            pipeline: pipeline.into(),
            video: "copy".into(),
            audio: audio.into(),
            extension: target.into(),
            uses_bitrate: transcode_audio,
            ..base
        },
        i,
    )
}

/// Applies resource limits and marks the plan valid when no issue remains.
fn finalize(plan: Plan, i: &PlanInput) -> Plan {
    let mut issues = plan.issues.clone();
    let mut warnings = plan.warnings.clone().unwrap_or_default();
    let limit_bytes = i.limits.max_memory_mb * 1024.0 * 1024.0;
    // Only FFmpeg holds its output in memory. A single stream that cannot fit falls back to saving the downloaded file:
    // warn, never refuse. Two tracks (separate audio) can only become one file through FFmpeg: there it is refused.
    if plan.requires_ffmpeg && i.estimated_bytes.is_some_and(|b| b > limit_bytes) {
        if i.separate_audio {
            issues.push("too-large".into());
        } else {
            warnings.push("large-for-memory".into());
        }
    }
    if plan.requires_ffmpeg
        && i.limits.max_encode_duration_sec > 0.0
        && i.duration_sec
            .is_some_and(|d| d > i.limits.max_encode_duration_sec)
    {
        issues.push("too-long-to-encode".into());
    }
    let valid = issues.is_empty();
    Plan {
        issues,
        warnings: (!warnings.is_empty()).then_some(warnings),
        valid,
        ..plan
    }
}

/// Audio bitrate options that are meaningful for the given plan. Empty when the choice would have no effect.
pub fn bitrate_options(plan: &Plan) -> Vec<f64> {
    if plan.uses_bitrate {
        vec![128.0, 192.0, 256.0, 320.0]
    } else {
        Vec::new()
    }
}
