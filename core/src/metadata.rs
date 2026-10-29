//! Media a page announces through public, standard metadata, from `src/lib/metadata.ts`: Open Graph / Twitter tags,
//! JSON-LD (schema.org `VideoObject` and `AudioObject`), `<link rel="alternate">` and podcast feeds (RSS enclosures,
//! Atom). The page is hostile input: everything is validated and bounded; nothing is fetched or run.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::dash::parse_iso_duration;
use crate::hook_data::has_extension;
use crate::js::{is_js_space, len_utf16, slice_utf16, trim};
use crate::url::{is_safe_fetch_url, parse_url};
use crate::xml::{XmlLimits, local_name, parse_xml};

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaMedia {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
}

pub const MAX_META_ITEMS: usize = 60;
const MAX_TEXT: usize = 200;

/// A trimmed, non-empty string cut to 200 UTF-16 units.
fn clip(s: Option<&Value>) -> Option<String> {
    let t = trim(s?.as_str()?);
    (!t.is_empty()).then(|| slice_utf16(t, MAX_TEXT).to_string())
}

/// An absolute http(s) address (relative ones are resolved against `base`), or `None`.
pub fn safe_abs(raw: Option<&Value>, base: &str) -> Option<String> {
    safe_abs_str(raw?.as_str()?, base)
}

pub fn safe_abs_str(raw: &str, base: &str) -> Option<String> {
    if len_utf16(raw) > 2048 || trim(raw).is_empty() {
        return None;
    }
    let u = parse_url(trim(raw), Some(base))?;
    is_safe_fetch_url(u.as_str()).then(|| u.to_string())
}

/// `video` or `audio` from a MIME type; `None` for anything else (images, HTML players, flash).
pub fn media_type_of_mime(mime: Option<&str>) -> Option<&'static str> {
    let m = mime.unwrap_or("").to_lowercase();
    if m.starts_with("video/") {
        Some("video")
    } else if m.starts_with("audio/") {
        Some("audio")
    } else if matches!(
        m.as_str(),
        "application/vnd.apple.mpegurl" | "application/x-mpegurl" | "application/dash+xml"
    ) {
        Some("video")
    } else {
        None
    }
}

/// A positive finite number, or a string that reads as one.
fn num(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => crate::js::number(s),
        _ => return None,
    };
    (n.is_finite() && n > 0.0).then_some(n)
}

/// The first part of a MIME type, trimmed and lower-cased.
fn essence(mime: &str) -> String {
    trim(mime.split(';').next().unwrap_or("")).to_lowercase()
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MetaTag {
    /// property= or name=
    pub key: String,
    pub content: String,
}

/// og:video (+ :url, :secure_url, :type, :width, :height), og:audio and twitter:player:stream. A tag whose address is a
/// web page (text/html, an embed player) is not a file.
pub fn media_from_meta_tags(tags: &[MetaTag], base: &str) -> Vec<MetaMedia> {
    let mut out: Vec<MetaMedia> = Vec::new();
    let first = |key: &str| {
        tags.iter()
            .find(|t| t.key == key)
            .map(|t| t.content.as_str())
    };
    let as_value = |s: Option<&str>| s.map(|s| Value::String(s.into()));
    let title = clip(as_value(first("og:title")).as_ref())
        .or_else(|| clip(as_value(first("twitter:title")).as_ref()));
    let poster = first("og:image")
        .or_else(|| first("twitter:image"))
        .and_then(|p| safe_abs_str(p, base));
    let w = num(as_value(first("og:video:width")).as_ref());
    let h = num(as_value(first("og:video:height")).as_ref());
    let size = w.zip(h);
    let mut seen: Vec<String> = Vec::new();
    let mut add = |url: &str, kind: &'static str, mime: Option<&str>, size: Option<(f64, f64)>| {
        let Some(abs) = safe_abs_str(url, base) else {
            return;
        };
        if seen.contains(&abs) || out.len() >= MAX_META_ITEMS {
            return;
        }
        let ty = essence(mime.unwrap_or(""));
        // an embed page is not media (the player inside it is found when its frame is scanned)
        if ty == "text/html" || ty == "application/x-shockwave-flash" {
            return;
        }
        seen.push(abs.clone());
        out.push(MetaMedia {
            url: abs,
            mime_type: (!ty.is_empty()).then(|| ty.clone()),
            media_type: Some(media_type_of_mime(Some(&ty)).unwrap_or(kind)),
            title: title.clone(),
            poster: poster.clone(),
            width: size.map(|s| s.0),
            height: size.map(|s| s.1),
            ..MetaMedia::default()
        });
    };
    let vtype = first("og:video:type");
    for k in ["og:video", "og:video:url", "og:video:secure_url"] {
        for t in tags.iter().filter(|t| t.key == k) {
            add(&t.content, "video", vtype, size);
        }
    }
    let atype = first("og:audio:type");
    for k in ["og:audio", "og:audio:url", "og:audio:secure_url"] {
        for t in tags.iter().filter(|t| t.key == k) {
            add(&t.content, "audio", atype, None);
        }
    }
    if let Some(stream) = first("twitter:player:stream").filter(|s| !s.is_empty()) {
        add(
            stream,
            "video",
            first("twitter:player:stream:content_type"),
            size,
        );
    }
    out
}

const LD_TYPES: [&str; 4] = ["VideoObject", "AudioObject", "MusicRecording", "Clip"];

fn ld_types(node: &serde_json::Map<String, Value>) -> Vec<&str> {
    match node.get("@type") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        Some(Value::String(s)) => vec![s.as_str()],
        _ => Vec::new(),
    }
}

fn walk_ld<'a>(value: &'a Value, depth: usize, out: &mut Vec<&'a serde_json::Map<String, Value>>) {
    if depth > 6 {
        return;
    }
    match value {
        Value::Array(a) => {
            for v in a.iter().take(100) {
                walk_ld(v, depth + 1, out);
            }
        }
        Value::Object(node) => {
            out.push(node);
            for key in [
                "@graph",
                "video",
                "audio",
                "mainEntity",
                "hasPart",
                "associatedMedia",
                "subjectOf",
            ] {
                if let Some(v) = node.get(key) {
                    walk_ld(v, depth + 1, out);
                }
            }
        }
        _ => {}
    }
}

/// `contentUrl` of VideoObject / AudioObject nodes. `embedUrl` is a web page and is deliberately ignored.
pub fn media_from_json_ld(text: &str, base: &str) -> Vec<MetaMedia> {
    if len_utf16(text) > 1_000_000 {
        return Vec::new();
    }
    let Ok(data) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    walk_ld(&data, 0, &mut nodes);
    let mut out: Vec<MetaMedia> = Vec::new();
    for node in nodes {
        let types = ld_types(node);
        if !types.iter().any(|t| LD_TYPES.contains(t)) {
            continue;
        }
        let content = node.get("contentUrl");
        let urls: Vec<Option<&Value>> = match content {
            Some(Value::Array(a)) => a.iter().take(10).map(Some).collect(),
            other => vec![other],
        };
        for raw in urls {
            let Some(url) = safe_abs(raw, base) else {
                continue;
            };
            if out.iter().any(|o| o.url == url) || out.len() >= MAX_META_ITEMS {
                continue;
            }
            let format = node.get("encodingFormat").and_then(Value::as_str);
            let thumb = match node.get("thumbnailUrl") {
                Some(Value::Array(a)) => a.first(),
                other => other,
            };
            out.push(MetaMedia {
                url,
                mime_type: format.map(|f| slice_utf16(&f.to_lowercase(), 100).to_string()),
                media_type: Some(media_type_of_mime(format).unwrap_or(
                    if types.contains(&"VideoObject") {
                        "video"
                    } else {
                        "audio"
                    },
                )),
                title: clip(node.get("name")),
                duration_sec: node
                    .get("duration")
                    .and_then(Value::as_str)
                    .and_then(|d| parse_iso_duration(Some(d))),
                width: num(node.get("width")),
                height: num(node.get("height")),
                poster: safe_abs(thumb, base),
            });
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LinkTag {
    pub rel: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub href: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LinkMedia {
    pub media: Vec<MetaMedia>,
    pub feeds: Vec<String>,
}

/// `/(^|\s)alternate(\s|$)/i`
fn has_token(rel: &str, token: &str) -> bool {
    rel.split(is_js_space)
        .any(|t| t.eq_ignore_ascii_case(token))
}

/// Alternate representations of the page that are media files themselves, and the feeds the page offers.
pub fn media_from_links(links: &[LinkTag], base: &str) -> LinkMedia {
    let mut out = LinkMedia::default();
    for l in links {
        if !has_token(&l.rel, "alternate") {
            continue;
        }
        let ty = essence(&l.ty);
        let Some(url) = safe_abs_str(&l.href, base) else {
            continue;
        };
        if matches!(ty.as_str(), "application/rss+xml" | "application/atom+xml") {
            if out.feeds.len() < 3 {
                out.feeds.push(url);
            }
        } else if let Some(kind) =
            media_type_of_mime(Some(&ty)).filter(|_| out.media.len() < MAX_META_ITEMS)
        {
            out.media.push(MetaMedia {
                url,
                mime_type: Some(ty),
                media_type: Some(kind),
                title: clip(l.title.as_ref().map(|t| Value::String(t.clone())).as_ref()),
                ..MetaMedia::default()
            });
        }
    }
    out
}

const AUDIO_VIDEO_EXT: &[&str] = &[
    "mp3", "m4a", "aac", "ogg", "oga", "opus", "flac", "wav", "mp4", "m4v", "webm", "mov", "ogv",
];
const VIDEO_EXT: &[&str] = &["mp4", "m4v", "webm", "mov", "ogv"];

/// `/^(?:(\d+):)?(\d{1,2}):(\d{2})$/` to seconds.
fn clock_seconds(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.split(':').collect();
    let digits = |p: &str, min: usize, max: usize| {
        (min..=max).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit())
    };
    let n = |p: &str| p.parse::<f64>().unwrap_or(f64::NAN);
    match parts.as_slice() {
        [m, s] if digits(m, 1, 2) && digits(s, 2, 2) => Some(n(m) * 60.0 + n(s)),
        [h, m, s] if digits(h, 1, usize::MAX) && digits(m, 1, 2) && digits(s, 2, 2) => {
            Some(n(h) * 3600.0 + n(m) * 60.0 + n(s))
        }
        _ => None,
    }
}

/// RSS `<enclosure>` and Atom `<link rel="enclosure">` entries that are audio or video.
pub fn media_from_feed(text: &str, base: &str) -> Vec<MetaMedia> {
    if len_utf16(text) > 2_000_000 {
        return Vec::new();
    }
    let Some(root) = parse_xml(text, XmlLimits::default()) else {
        return Vec::new();
    };
    let mut out: Vec<MetaMedia> = Vec::new();
    let mut consider =
        |url: Option<&str>, ty: Option<&str>, title: Option<&str>, dur: Option<f64>| {
            let Some(abs) = url.and_then(|u| safe_abs_str(u, base)) else {
                return;
            };
            let mime = ty.map(essence).filter(|m| !m.is_empty());
            if out.len() >= MAX_META_ITEMS || out.iter().any(|o| o.url == abs) {
                return;
            }
            let kind = media_type_of_mime(mime.as_deref()).or_else(|| {
                has_extension(&abs, AUDIO_VIDEO_EXT).then(|| {
                    if has_extension(&abs, VIDEO_EXT) {
                        "video"
                    } else {
                        "audio"
                    }
                })
            });
            let Some(kind) = kind else { return };
            out.push(MetaMedia {
                url: abs,
                mime_type: mime,
                media_type: Some(kind),
                title: clip(title.map(|t| Value::String(t.into())).as_ref()),
                duration_sec: dur,
                ..MetaMedia::default()
            });
        };
    if let Some(channel) = root.first_child("channel") {
        for item in channel.children_named("item") {
            let title = item.first_child("title").map(|t| t.text.as_str());
            let dur = item
                .children
                .iter()
                .find(|c| local_name(&c.name).to_lowercase() == "duration")
                .map(|c| trim(&c.text));
            let sec = dur.filter(|d| !d.is_empty()).and_then(|d| {
                if d.bytes().all(|b| b.is_ascii_digit()) {
                    Some(crate::js::number(d))
                } else {
                    clock_seconds(d)
                }
            });
            for enc in item.children_named("enclosure") {
                consider(enc.attrs.get("url"), enc.attrs.get("type"), title, sec);
            }
        }
    }
    for entry in root.children_named("entry") {
        let title = entry.first_child("title").map(|t| t.text.as_str());
        for l in entry.children_named("link") {
            if l.attrs.get("rel").unwrap_or("").to_lowercase() == "enclosure" {
                consider(l.attrs.get("href"), l.attrs.get("type"), title, None);
            }
        }
    }
    out
}
