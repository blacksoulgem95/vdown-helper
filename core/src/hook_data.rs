//! What the page hook reports, from `src/lib/hookData.ts`. The page controls the world the hook runs in, so every field
//! is untrusted: it is validated and size-capped before it becomes a candidate or decides a verdict.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::data_url::data_handle;
use crate::js::len_utf16;
use crate::obj::{num_of, object};
use crate::security::normalize_url;
use crate::url::is_safe_fetch_url;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRequest {
    pub url: String,
    /// Response content type, when the page's own request got a response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default = "fetch")]
    pub via: String,
}

fn fetch() -> String {
    "fetch".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookBuffer {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub mime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookMediaSource {
    pub url: String,
    #[serde(default)]
    pub buffers: Vec<HookBuffer>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookReport {
    #[serde(default)]
    pub requests: Vec<HookRequest>,
    /// Key systems the page asked for through EME (e.g. "com.widevine.alpha").
    #[serde(default)]
    pub eme_key_systems: Vec<String>,
    /// MediaSources the page created, by the blob: URL it gave its player, with their SourceBuffers.
    #[serde(default)]
    pub media_sources: Vec<HookMediaSource>,
}

const MAX_REQUESTS: usize = 300;
const MAX_KEY_SYSTEMS: usize = 8;
const MAX_MEDIA_SOURCES: usize = 30;

/// True when `url` holds `.<ext>` (any of `exts`, ASCII case-insensitive) followed by its end, `?` or `#`.
pub fn has_extension(url: &str, exts: &[&str]) -> bool {
    let lower = url.to_ascii_lowercase();
    let b = lower.as_bytes();
    lower.match_indices('.').any(|(i, _)| {
        exts.iter().any(|e| {
            lower[i + 1..].starts_with(e)
                && matches!(b.get(i + 1 + e.len()), None | Some(b'?' | b'#'))
        })
    })
}

const MANIFEST_EXT: &[&str] = &["m3u8", "mpd", "ism/manifest", "f4m"];
const FILE_EXT: &[&str] = &[
    "mp4", "m4v", "webm", "mkv", "mov", "flv", "avi", "wmv", "3gp", "mpg", "mpeg", "ogv", "mp3",
    "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "vtt", "srt", "ttml", "dfxp",
];
/// Media segments are an implementation detail of a manifest and are never listed on their own.
const SEGMENT_EXT: &[&str] = &[
    "ts", "m4s", "cmfv", "cmfa", "cmft", "aac", "webvtt", "key", "bin",
];

fn is_media_type(ct: &str) -> bool {
    let c = ct.to_ascii_lowercase();
    ["video/", "audio/", "text/vtt"]
        .iter()
        .any(|p| c.starts_with(p))
        || [
            "vnd.apple.mpegurl",
            "x-mpegurl",
            "dash+xml",
            "vnd.ms-sstr+xml",
            "ogg",
            "x-subrip",
            "ttml+xml",
        ]
        .iter()
        .any(|p| {
            c.strip_prefix("application/")
                .is_some_and(|r| r.starts_with(p))
        })
}

pub fn is_interesting(req: &HookRequest) -> bool {
    if has_extension(&req.url, MANIFEST_EXT) {
        return true;
    }
    if has_extension(&req.url, SEGMENT_EXT) && !has_extension(&req.url, &["aac"]) {
        return false;
    }
    has_extension(&req.url, FILE_EXT) || req.content_type.as_deref().is_some_and(is_media_type)
}

/// A non-empty string of at most `max` UTF-16 units.
fn str_field(v: Option<&Value>, max: usize) -> Option<&str> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty() && len_utf16(s) <= max)
}

/// The named fields of an object (an array has none, so it is skipped like the TypeScript's missing `url`).
fn fields(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

fn list(v: Option<&Value>, max: usize) -> &[Value] {
    v.and_then(Value::as_array)
        .map_or(&[], |a| &a[..a.len().min(max)])
}

/// Arbitrary data from the page made into a clean report. Never fails.
pub fn parse_hook_report(raw: &Value) -> HookReport {
    let mut out = HookReport::default();
    let Some(r) = fields(raw) else {
        return out;
    };
    for item in list(r.get("requests"), MAX_REQUESTS * 2) {
        let Some(i) = fields(item) else { continue };
        let Some(url) = str_field(i.get("url"), 4096).filter(|u| is_safe_fetch_url(u)) else {
            continue;
        };
        out.requests.push(HookRequest {
            url: url.into(),
            content_type: str_field(i.get("contentType"), 200).map(Into::into),
            via: if i.get("via").and_then(Value::as_str) == Some("xhr") {
                "xhr".into()
            } else {
                "fetch".into()
            },
        });
        if out.requests.len() >= MAX_REQUESTS {
            break;
        }
    }
    for item in list(r.get("mediaSources"), MAX_MEDIA_SOURCES) {
        let Some(i) = fields(item) else { continue };
        let Some(url) = str_field(i.get("url"), 4096)
            .filter(|u| u.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("blob:")))
        else {
            continue;
        };
        let buffers = list(i.get("buffers"), 8)
            .iter()
            .filter_map(fields)
            .filter_map(|b| {
                let id = str_field(b.get("id"), 20)
                    .filter(|id| id.bytes().all(|c| c.is_ascii_digit()))?;
                let mime = str_field(b.get("mime"), 200)?;
                Some(HookBuffer {
                    id: id.into(),
                    mime: mime.into(),
                })
            })
            .collect();
        out.media_sources.push(HookMediaSource {
            url: url.into(),
            buffers,
        });
    }
    for k in list(r.get("emeKeySystems"), MAX_KEY_SYSTEMS) {
        if let Some(ks) = str_field(Some(k), 100).filter(|ks| {
            ks.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
        }) {
            out.eme_key_systems.push(ks.to_ascii_lowercase());
        }
    }
    out
}

/// Candidates (`RawCandidate`) for the interesting requests, deduplicated by normalised URL.
pub fn hook_candidates(
    report: &HookReport,
    frame_id: Option<f64>,
    frame_url: Option<&str>,
) -> Vec<Value> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for req in report.requests.iter().filter(|r| is_interesting(r)) {
        let key = normalize_url(&req.url);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let mut c = Map::new();
        c.insert("url".into(), req.url.clone().into());
        c.insert("method".into(), "hook".into());
        if let Some(ct) = req.content_type.as_deref().filter(|c| !c.is_empty()) {
            let mime = crate::js::trim(ct.split(';').next().unwrap_or("")).to_lowercase();
            c.insert("mimeType".into(), mime.into());
        }
        if let Some(id) = frame_id {
            c.insert("frameId".into(), crate::obj::number(id));
        }
        if let Some(u) = frame_url.filter(|u| !u.is_empty()) {
            c.insert("frameUrl".into(), u.into());
        }
        out.push(Value::Object(c));
    }
    out
}

/// Key systems that mean the stream is protected. ClearKey delivers its key in the clear and is not DRM.
pub fn protected_key_systems(systems: &[String]) -> Vec<String> {
    systems
        .iter()
        .filter(|s| *s != "org.w3.clearkey")
        .cloned()
        .collect()
}

fn with_verdict(r: &Value, status: &str, reason: &str, detail: Option<&str>) -> Value {
    let mut d = Map::new();
    d.insert("status".into(), status.into());
    d.insert("reason".into(), reason.into());
    if let Some(x) = detail {
        d.insert("detail".into(), x.into());
    }
    let mut next = object(r);
    next.insert("downloadability".into(), Value::Object(d));
    Value::Object(next)
}

/// Resources found in a frame whose page asked for a DRM key system are protected, whatever their container says.
pub fn mark_protected_frames(
    resources: &[Value],
    protected_by_frame: &[(f64, Vec<String>)],
) -> Vec<Value> {
    resources
        .iter()
        .map(|r| {
            let systems = num_of(r, "frameId")
                .and_then(|id| protected_by_frame.iter().find(|(f, _)| *f == id))
                .map(|(_, s)| s);
            match systems.and_then(|s| s.first()) {
                Some(first) => with_verdict(r, "protected", "eme", Some(first)),
                None => r.clone(),
            }
        })
        .collect()
}

/// Why the page hook has nothing to say about a frame: switched off, not allowed on that site, or there too late.
pub fn mse_missing_reason(hook_on: bool, site_allowed: bool) -> &'static str {
    if !hook_on {
        "mse-needs-hook"
    } else if site_allowed {
        "mse-needs-reload"
    } else {
        "mse-needs-access"
    }
}

/// Whether each MediaSource player (`held.kind === 'mse'`) can be captured, from what the hook of its own frame saw.
pub fn mark_mse_resources(
    resources: &[Value],
    reports: &[(f64, HookReport)],
    missing: &[(f64, String)],
) -> Vec<Value> {
    resources
        .iter()
        .map(|r| {
            let held = r.get("held").unwrap_or(&Value::Null);
            if held.get("kind").and_then(Value::as_str) != Some("mse") {
                return r.clone();
            }
            let frame = num_of(r, "frameId").unwrap_or(0.0);
            let Some((_, report)) = reports.iter().find(|(f, _)| *f == frame) else {
                return match missing.iter().find(|(f, _)| *f == frame) {
                    Some((_, reason)) => with_verdict(r, "unsupported", reason, None),
                    None => r.clone(),
                };
            };
            let id = held.get("id").and_then(Value::as_str);
            let source = report
                .media_sources
                .iter()
                .find(|m| Some(data_handle(&m.url).as_str()) == id);
            if source.is_none_or(|s| s.buffers.is_empty()) {
                return with_verdict(r, "unsupported", "mse-unrecordable", None);
            }
            // Any key system means the data the player is given is encrypted: nothing usable could be recorded.
            if !report.eme_key_systems.is_empty() {
                let drm = protected_key_systems(&report.eme_key_systems);
                return match drm.first() {
                    Some(ks) => with_verdict(r, "protected", "eme", Some(ks)),
                    None => with_verdict(r, "unsupported", "mse-unrecordable", Some("clearkey")),
                };
            }
            with_verdict(r, "downloadable", "ok", Some("mse-capturable"))
        })
        .collect()
}
