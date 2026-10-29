//! Media helpers from `src/lib/media.ts` (the rest of the module arrives in VDH-064).

use crate::url::parse_url;

/// Lower-cased extension of the last path segment (`""` when there is none).
pub fn extension_of(url: &str) -> String {
    let Some(u) = parse_url(url, None) else {
        return String::new();
    };
    let last = u.path().rsplit('/').next().unwrap_or("");
    last.rfind('.')
        .map_or_else(String::new, |d| last[d + 1..].to_lowercase())
}

/// Bytes for a bit rate and a duration, rounded; `None` when either is missing or not positive.
pub fn estimate_bytes(bits_per_second: Option<f64>, duration_sec: Option<f64>) -> Option<f64> {
    let (b, d) = (bits_per_second?, duration_sec?);
    (b > 0.0 && d > 0.0).then(|| (b * d / 8.0).round())
}

/// `720p` from a height, `1280w` from a width, `""` otherwise.
pub fn resolution_label(height: Option<f64>, width: Option<f64>) -> String {
    match (
        height.filter(|h| *h != 0.0 && !h.is_nan()),
        width.filter(|w| *w != 0.0 && !w.is_nan()),
    ) {
        (Some(h), _) => format!("{}p", crate::js::number_to_string(h)),
        (None, Some(w)) => format!("{}w", crate::js::number_to_string(w)),
        _ => String::new(),
    }
}

/// Format named by a MIME type (parameters ignored).
pub fn format_from_mime(mime: Option<&str>) -> Option<&'static str> {
    let key = crate::js::trim(
        mime.filter(|m| !m.is_empty())?
            .split(';')
            .next()
            .unwrap_or(""),
    )
    .to_lowercase();
    Some(match key.as_str() {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "video/quicktime" => "mov",
        "video/ogg" => "ogv",
        "video/mp2t" => "ts",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "wav",
        "audio/ogg" => "ogg",
        "audio/flac" => "flac",
        "audio/opus" => "opus",
        "audio/aiff" | "audio/x-aiff" => "aiff",
        "audio/x-ms-wma" => "wma",
        "video/x-flv" => "flv",
        "video/x-msvideo" | "video/avi" => "avi",
        "video/x-ms-wmv" => "wmv",
        "video/x-ms-asf" => "asf",
        "video/3gpp" | "video/3gpp2" => "3gp",
        "video/mpeg" => "mpg",
        "application/vnd.apple.mpegurl" | "application/x-mpegurl" => "hls",
        "audio/mpegurl" | "audio/x-mpegurl" => "m3u",
        "application/dash+xml" => "dash",
        "text/vtt" => "vtt",
        "application/x-subrip" | "text/srt" => "srt",
        "application/ttml+xml" => "ttml",
        _ => return None,
    })
}

/// Formats that hold only audio.
pub fn is_audio_only_format(format: &str) -> bool {
    matches!(
        format,
        "mp3" | "m4a" | "aac" | "wav" | "ogg" | "flac" | "opus" | "aiff" | "wma"
    )
}

/// Subtitle documents that are saved or converted as text.
pub fn is_subtitle_file_format(format: &str) -> bool {
    matches!(format, "vtt" | "srt" | "ttml")
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct CodecFamilies {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<&'static str>,
}

/// Video and audio codec families of an RFC 6381 `codecs` string (the first of each kind wins).
pub fn codec_families(codecs: Option<&str>) -> CodecFamilies {
    let mut out = CodecFamilies::default();
    let Some(codecs) = codecs.filter(|c| !c.is_empty()) else {
        return out;
    };
    for raw in codecs.split(',') {
        let c = crate::js::trim(raw).to_lowercase();
        if c.is_empty() {
            continue;
        }
        let (video, audio): (Option<&'static str>, Option<&'static str>) =
            if c.len() >= 4 && c.starts_with("avc") && matches!(c.as_bytes()[3], b'1'..=b'4') {
                (Some("h264"), None)
            } else if c.starts_with("hvc1")
                || c.starts_with("hev1")
                || c.starts_with("dvh1")
                || c.starts_with("dvhe")
            {
                (Some("hevc"), None)
            } else if c.starts_with("av01") {
                (Some("av1"), None)
            } else if c.starts_with("vp9") || c.starts_with("vp09") {
                (Some("vp9"), None)
            } else if c.starts_with("vp8") || c.starts_with("vp08") {
                (Some("vp8"), None)
            } else if c.starts_with("mp4v") {
                (Some("mpeg4"), None)
            } else if ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29", "mp4a.40.42"]
                .iter()
                .any(|p| c.starts_with(p))
            {
                (None, Some("aac"))
            } else if c.starts_with("mp4a.6b")
                || c.starts_with("mp4a.69")
                || c.starts_with("mp3")
                || c.starts_with(".mp3")
            {
                (None, Some("mp3"))
            } else if c == "ac-3" {
                (None, Some("ac3"))
            } else if c == "ec-3" {
                (None, Some("eac3"))
            } else if c == "opus" {
                (None, Some("opus"))
            } else if c == "vorbis" {
                (None, Some("vorbis"))
            } else if c == "flac" {
                (None, Some("flac"))
            } else if c.starts_with("mp4a") {
                (None, Some("unknown"))
            } else {
                (None, None)
            };
        if out.video.is_none() {
            out.video = video;
        }
        if out.audio.is_none() {
            out.audio = audio;
        }
    }
    out
}
