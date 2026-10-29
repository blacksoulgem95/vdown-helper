//! Media helpers from `src/lib/media.ts`: formats, labels, titles and codec descriptions.

use serde::Serialize;

use crate::js::{collapse_spaces, number_to_string, round, to_fixed};
use crate::url::parse_url;

/// `1.5 MB`; `""` for a missing, negative or infinite count.
pub fn format_bytes(bytes: Option<f64>) -> String {
    let Some(bytes) = bytes.filter(|b| b.is_finite() && *b >= 0.0) else {
        return String::new();
    };
    if bytes < 1024.0 {
        return format!("{} B", number_to_string(round(bytes)));
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut v = bytes / 1024.0;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!(
        "{} {}",
        to_fixed(v, if v >= 100.0 { 0 } else { 1 }),
        UNITS[i]
    )
}

/// `1:02:03` or `2:03`; `""` for a missing, negative or infinite duration.
pub fn format_duration(seconds: Option<f64>) -> String {
    let Some(seconds) = seconds.filter(|s| s.is_finite() && *s >= 0.0) else {
        return String::new();
    };
    let s = round(seconds);
    let h = (s / 3600.0).floor();
    let m = ((s % 3600.0) / 60.0).floor();
    let sec = s % 60.0;
    let mm = format!(
        "{:0>w$}",
        number_to_string(m),
        w = if h > 0.0 { 2 } else { 1 }
    );
    let ss = format!("{:0>2}", number_to_string(sec));
    if h > 0.0 {
        format!("{}:{mm}:{ss}", number_to_string(h))
    } else {
        format!("{mm}:{ss}")
    }
}

/// `2.5 Mbps` or `128 kbps`; `""` for a missing or non-positive rate.
pub fn format_bitrate(bits_per_second: Option<f64>) -> String {
    let Some(b) = bits_per_second.filter(|b| b.is_finite() && *b > 0.0) else {
        return String::new();
    };
    if b >= 1_000_000.0 {
        format!("{} Mbps", to_fixed(b / 1_000_000.0, 1))
    } else {
        format!("{} kbps", number_to_string(round(b / 1000.0)))
    }
}

/// `1.5 MB/s`; `""` when the rate is unknown.
pub fn format_speed(bytes_per_second: Option<f64>) -> String {
    let b = format_bytes(bytes_per_second);
    if b.is_empty() { b } else { format!("{b}/s") }
}

/// Resolution tier of a real pixel height (only used to label variants that exist).
pub fn quality_tag(height: Option<f64>) -> &'static str {
    let Some(h) = height.filter(|h| *h != 0.0 && !h.is_nan()) else {
        return "";
    };
    match h {
        h if h >= 2160.0 => "4K UHD",
        h if h >= 1440.0 => "QHD",
        h if h >= 1080.0 => "Full HD",
        h if h >= 720.0 => "HD",
        h if h >= 480.0 => "SD",
        _ => "Low",
    }
}

/// Format named by a file extension.
pub fn format_from_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "m4v" => "mp4",
        "webm" => "webm",
        "mkv" => "mkv",
        "mov" => "mov",
        "ogv" => "ogv",
        "ts" => "ts",
        "mp3" => "mp3",
        "m4a" => "m4a",
        "aac" => "aac",
        "wav" => "wav",
        "ogg" | "oga" => "ogg",
        "opus" => "opus",
        "flac" => "flac",
        "aif" | "aiff" | "aifc" => "aiff",
        "wma" => "wma",
        "flv" => "flv",
        "avi" => "avi",
        "wmv" => "wmv",
        "asf" => "asf",
        "3gp" | "3g2" => "3gp",
        "mpg" | "mpeg" | "mpe" => "mpg",
        "m3u8" => "hls",
        "m3u" => "m3u",
        "mpd" => "dash",
        "vtt" | "webvtt" => "vtt",
        "srt" => "srt",
        "ttml" | "dfxp" => "ttml",
        _ => return None,
    })
}

/// Format named by the extension of a URL's last path segment.
pub fn format_from_url(url: &str) -> Option<&'static str> {
    format_from_extension(&extension_of(url))
}

/// Formats that can hold video (HLS included: its variants usually do).
pub fn is_video_format(format: &str) -> bool {
    matches!(
        format,
        "mp4"
            | "webm"
            | "mkv"
            | "mov"
            | "ogv"
            | "ts"
            | "flv"
            | "avi"
            | "wmv"
            | "asf"
            | "3gp"
            | "mpg"
            | "hls"
    )
}

/// `video`, `audio` or `unknown` for a format.
pub fn media_type_of(format: &str) -> &'static str {
    if is_audio_only_format(format) {
        "audio"
    } else if is_video_format(format) {
        "video"
    } else {
        "unknown"
    }
}

/// Segment names that say nothing about the media (index, master, playlist, 12345.ts, long hex ids).
fn is_generic_segment(base: &str) -> bool {
    let lower = base.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "index"
            | "master"
            | "playlist"
            | "manifest"
            | "video"
            | "stream"
            | "main"
            | "chunklist"
            | "media"
    ) || (!base.is_empty() && base.bytes().all(|b| b.is_ascii_digit()))
        || (base.len() >= 16 && base.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `base.replace(/\.[a-z0-9]{2,5}$/i, '')`.
fn strip_extension(base: &str) -> &str {
    if let Some(dot) = base.rfind('.') {
        let ext = &base[dot + 1..];
        if (2..=5).contains(&ext.len()) && ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return &base[..dot];
        }
    }
    base
}

/// Best-effort title: the element's own, the URL's last path segment unless it is generic, the page title, the host.
pub fn infer_title(url: &str, element_title: Option<&str>, page_title: Option<&str>) -> String {
    let el = collapse_spaces(element_title.unwrap_or(""));
    if !el.is_empty() {
        return el;
    }
    let u = parse_url(url, None);
    if let Some(u) = &u {
        let seg = u.path().split('/').rfind(|s| !s.is_empty()).unwrap_or("");
        let seg = crate::js::decode_uri_component(seg).unwrap_or_else(|| seg.to_string());
        let base = strip_extension(&seg);
        if !base.is_empty() && !is_generic_segment(base) {
            return collapse_spaces(&base.replace('_', " "));
        }
    }
    let page = collapse_spaces(page_title.unwrap_or(""));
    if !page.is_empty() {
        return page;
    }
    u.map_or_else(
        || "media".into(),
        |u| u.host_str().unwrap_or("").to_string(),
    )
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Codec {
    pub family: &'static str,
    pub label: &'static str,
}

/// What an RFC 6381 `codecs` string names (the first codec of each kind wins).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct CodecInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<Codec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<Codec>,
}

pub fn describe_codecs(codecs: Option<&str>) -> CodecInfo {
    let mut out = CodecInfo::default();
    let Some(codecs) = codecs.filter(|c| !c.is_empty()) else {
        return out;
    };
    let v = |family, label| (Some(Codec { family, label }), None);
    let a = |family, label| (None, Some(Codec { family, label }));
    for raw in codecs.split(',') {
        let c = crate::js::trim(raw).to_lowercase();
        if c.is_empty() {
            continue;
        }
        let (video, audio): (Option<Codec>, Option<Codec>) =
            if c.len() >= 4 && c.starts_with("avc") && matches!(c.as_bytes()[3], b'1'..=b'4') {
                v("h264", "H.264")
            } else if c.starts_with("hvc1") || c.starts_with("hev1") {
                v("hevc", "H.265")
            } else if c.starts_with("dvh1") || c.starts_with("dvhe") {
                v("hevc", "Dolby Vision (HEVC)")
            } else if c.starts_with("av01") {
                v("av1", "AV1")
            } else if c.starts_with("vp9") || c.starts_with("vp09") {
                v("vp9", "VP9")
            } else if c.starts_with("vp8") || c.starts_with("vp08") {
                v("vp8", "VP8")
            } else if c.starts_with("mp4v") {
                v("mpeg4", "MPEG-4")
            } else if ["mp4a.40.2", "mp4a.40.5", "mp4a.40.29", "mp4a.40.42"]
                .iter()
                .any(|p| c.starts_with(p))
            {
                a("aac", "AAC")
            } else if c.starts_with("mp4a.6b")
                || c.starts_with("mp4a.69")
                || c.starts_with("mp3")
                || c.starts_with(".mp3")
            {
                a("mp3", "MP3")
            } else if c == "ac-3" {
                a("ac3", "AC-3")
            } else if c == "ec-3" {
                a("eac3", "E-AC-3")
            } else if c == "opus" {
                a("opus", "Opus")
            } else if c == "vorbis" {
                a("vorbis", "Vorbis")
            } else if c == "flac" {
                a("flac", "FLAC")
            } else if c.starts_with("mp4a") {
                a("unknown", "MPEG-4 Audio")
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
    let info = describe_codecs(codecs);
    CodecFamilies {
        video: info.video.map(|c| c.family),
        audio: info.audio.map(|c| c.family),
    }
}
