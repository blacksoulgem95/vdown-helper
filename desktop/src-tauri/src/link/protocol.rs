//! Protocol v1 between the extension and the app. Every message is a JSON object `{ "v": 1, "type": … }`; anything
//! else (another version, an unknown type, a malformed field) is refused. A job handed over is checked again here
//! whatever the extension says: the request must plan, its addresses must be http(s), page-held bytes cannot come this
//! way, and cookies are only accepted for the origins the request names as credentialed (the ones the user granted).

use serde::Deserialize;
use serde_json::Value;
use url::Url;
use vdh_core::request::DownloadRequest;
use vdh_engine::net::OriginCookies;
use vdh_engine::store::StoredHeaders;
use vdh_engine::{EngineError, Result};

pub const VERSION: u64 = 1;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Headers {
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CookieSet {
    pub origin: String,
    /// A `Cookie` header value.
    pub header: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Incoming {
    // what the extension says about itself: part of the handshake, not acted on yet
    #[allow(dead_code)]
    Hello {
        v: u64,
        ext_version: String,
        #[serde(default)]
        user_agent: Option<String>,
    },
    RunJob {
        v: u64,
        job_id: String,
        request: Value,
        #[serde(default)]
        headers: Option<Headers>,
        #[serde(default)]
        cookies: Option<Vec<CookieSet>>,
    },
    Cancel {
        v: u64,
        job_id: String,
    },
    Pause {
        v: u64,
        job_id: String,
    },
    Resume {
        v: u64,
        job_id: String,
    },
    Stop {
        v: u64,
        job_id: String,
    },
    Cookies {
        v: u64,
        job_id: String,
        cookies: Vec<CookieSet>,
    },
    Status {
        v: u64,
        job_ids: Vec<String>,
    },
}

impl Incoming {
    fn version(&self) -> u64 {
        match self {
            Self::Hello { v, .. }
            | Self::RunJob { v, .. }
            | Self::Cancel { v, .. }
            | Self::Pause { v, .. }
            | Self::Resume { v, .. }
            | Self::Stop { v, .. }
            | Self::Cookies { v, .. }
            | Self::Status { v, .. } => *v,
        }
    }
}

/// One message from the extension, or why it is refused.
pub fn parse(bytes: &[u8]) -> Result<Incoming> {
    let msg: Incoming = serde_json::from_slice(bytes)
        .map_err(|e| EngineError::invalid(format!("Not a message: {e}")))?;
    if msg.version() != VERSION {
        return Err(EngineError::invalid("Unsupported protocol version"));
    }
    Ok(msg)
}

fn http(u: &str) -> Option<Url> {
    Url::parse(u)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
}

/// A header value the extension passes on: one line, of reasonable length.
fn header_value(v: Option<&String>, max: usize) -> Option<String> {
    v.filter(|s| !s.is_empty() && s.len() <= max && !s.contains(['\r', '\n', '\0']))
        .cloned()
}

/// A job as the app will run it: the request, what its requests send, and the cookies (kept in memory only).
pub struct Handover {
    pub request: DownloadRequest,
    pub headers: StoredHeaders,
    pub cookies: Vec<OriginCookies>,
}

/// Check a handed-over job. The request must describe something the app fetches itself: page-held bytes, captures,
/// recordings of a page and ZIPs of page files stay in the browser.
pub fn handover(
    request: Value,
    headers: Option<Headers>,
    cookies: Option<Vec<CookieSet>>,
) -> Result<Handover> {
    let request: DownloadRequest = serde_json::from_value(request)
        .map_err(|e| EngineError::invalid(format!("Not a download request: {e}")))?;
    if request.held.is_some()
        || request.capture.is_some()
        || request.record.is_some()
        || request.zip.is_some()
    {
        return Err(EngineError::invalid(
            "Page-held media cannot be handed to the app",
        ));
    }
    if http(&request.source_url).is_none()
        || request
            .audio_url
            .as_deref()
            .is_some_and(|a| http(a).is_none())
    {
        return Err(EngineError::invalid(
            "Only http(s) addresses can be handed over",
        ));
    }
    let h = headers.unwrap_or_default();
    let referer = h.referer.as_deref().and_then(http).map(String::from);
    let origin = h
        .origin
        .as_deref()
        .and_then(http)
        .map(|u| u.origin().ascii_serialization());
    let granted: Vec<String> = request
        .credentialed_origins
        .clone()
        .unwrap_or_default()
        .iter()
        .filter_map(|o| http(o).map(|u| u.origin().ascii_serialization()))
        .collect();
    let cookies: Vec<OriginCookies> = cookies
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| {
            let origin = http(&c.origin)?.origin().ascii_serialization();
            let header = header_value(Some(&c.header), 16 * 1024)?;
            granted
                .contains(&origin)
                .then_some(OriginCookies { origin, header })
        })
        .collect();
    let headers = StoredHeaders {
        referer,
        origin,
        user_agent: header_value(h.user_agent.as_ref(), 512),
        cookie_origins: cookies.iter().map(|c| c.origin.clone()).collect(),
    };
    Ok(Handover {
        request,
        headers,
        cookies,
    })
}

/// Cookies sent later for a job (after the app restarted), held to the origins the job named when it was handed over.
pub fn cookies_for(granted: &[String], cookies: Vec<CookieSet>) -> Vec<OriginCookies> {
    cookies
        .into_iter()
        .filter_map(|c| {
            let origin = http(&c.origin)?.origin().ascii_serialization();
            let header = header_value(Some(&c.header), 16 * 1024)?;
            granted
                .contains(&origin)
                .then_some(OriginCookies { origin, header })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> Value {
        json!({
            "resourceId": "r1",
            "sourceUrl": "https://cdn.example/v/master.m3u8",
            "tabId": 3,
            "pageUrl": "https://site.example/watch",
            "host": "site.example",
            "mode": "video-audio",
            "container": "mp4",
            "audioFormat": "mp3",
            "audioBitrate": 192,
            "filename": "Clip.mp4",
            "subfolder": "",
            "qualityLabel": "720p",
            "isHls": true,
            "sourceFormat": "hls",
            "hasMuxedAudio": true,
            "hasVideo": true,
            "credentialedOrigins": ["https://site.example"]
        })
    }

    #[test]
    fn messages_need_version_1_a_known_type_and_no_extra_fields() {
        assert!(matches!(
            parse(br#"{"v":1,"type":"hello","extVersion":"1.3.0"}"#),
            Ok(Incoming::Hello { .. })
        ));
        assert!(parse(br#"{"v":2,"type":"hello","extVersion":"1"}"#).is_err());
        assert!(parse(br#"{"type":"hello","extVersion":"1"}"#).is_err());
        assert!(parse(br#"{"v":1,"type":"shell","cmd":"rm"}"#).is_err());
        assert!(parse(br#"{"v":1,"type":"cancel","jobId":"a","path":"/"}"#).is_err());
        assert!(parse(b"not json").is_err());
        assert!(matches!(
            parse(br#"{"v":1,"type":"status","jobIds":["a","b"]}"#),
            Ok(Incoming::Status { job_ids, .. }) if job_ids.len() == 2
        ));
    }

    #[test]
    fn a_handover_keeps_cookies_only_for_granted_origins() {
        let h = handover(
            request(),
            Some(Headers {
                referer: Some("https://site.example/watch".into()),
                origin: Some("https://site.example/whatever".into()),
                user_agent: Some("Mozilla/5.0".into()),
            }),
            Some(vec![
                CookieSet {
                    origin: "https://site.example".into(),
                    header: "sid=1".into(),
                },
                CookieSet {
                    origin: "https://tracker.example".into(),
                    header: "t=2".into(),
                },
                CookieSet {
                    origin: "https://site.example".into(),
                    header: "a=1\r\nX-Evil: 1".into(),
                },
            ]),
        )
        .expect("valid");
        assert_eq!(h.cookies.len(), 1);
        assert_eq!(h.cookies[0].origin, "https://site.example");
        assert_eq!(h.headers.cookie_origins, ["https://site.example"]);
        assert_eq!(h.headers.origin.as_deref(), Some("https://site.example"));
        assert_eq!(h.headers.user_agent.as_deref(), Some("Mozilla/5.0"));
        assert_eq!(cookies_for(&h.headers.cookie_origins, vec![]).len(), 0);
    }

    #[test]
    fn page_held_media_and_other_schemes_are_refused() {
        for (k, v) in [
            ("held", json!({"kind": "blob"})),
            ("capture", json!({"speed": "fast"})),
            ("zip", json!({"items": []})),
            ("sourceUrl", json!("file:///etc/passwd")),
            ("audioUrl", json!("ftp://x/y")),
        ] {
            let mut r = request();
            r[k] = v;
            assert!(handover(r, None, None).is_err(), "{k}");
        }
        assert!(handover(json!({"sourceUrl": 1}), None, None).is_err());
    }

    #[test]
    fn bad_headers_are_dropped_not_passed_on() {
        let h = handover(
            request(),
            Some(Headers {
                referer: Some("javascript:alert(1)".into()),
                origin: None,
                user_agent: Some("UA\r\nCookie: x".into()),
            }),
            None,
        )
        .expect("valid");
        assert_eq!(h.headers.referer, None);
        assert_eq!(h.headers.user_agent, None);
        assert!(h.headers.cookie_origins.is_empty());
    }
}
