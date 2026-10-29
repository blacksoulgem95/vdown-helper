//! HTTP for one job: the system proxy, the Referer / Origin / User-Agent the job was handed, and cookies only for the
//! origins they were given for (kept in memory, never written or logged). Redirects stay on http(s); transient failures
//! are retried with a short backoff.

use std::time::Duration;

use reqwest::header::{COOKIE, HeaderMap, HeaderValue, ORIGIN, RANGE, REFERER, USER_AGENT};
use reqwest::{Response, StatusCode, redirect};
use vdh_core::hls::HlsByteRange;
use vdh_core::security::redact_url;
use vdh_core::url::is_safe_fetch_url;

use crate::error::{EngineError, ErrorCode, Result};

/// A User-Agent for jobs that did not come from a browser.
pub const DEFAULT_USER_AGENT: &str = concat!(
    "Mozilla/5.0 (compatible; vdown-helper/",
    env!("CARGO_PKG_VERSION"),
    ")"
);

/// The largest text document (playlist, manifest, page) read into memory.
pub const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

/// Cookies for one origin (`scheme://host[:port]`), as a `Cookie` header value.
#[derive(Clone, Default)]
pub struct OriginCookies {
    pub origin: String,
    pub header: String,
}

impl std::fmt::Debug for OriginCookies {
    // never print cookie values
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OriginCookies")
            .field("origin", &self.origin)
            .finish_non_exhaustive()
    }
}

/// What the requests of one job send.
#[derive(Debug, Clone, Default)]
pub struct RequestHeaders {
    pub referer: Option<String>,
    pub origin: Option<String>,
    pub user_agent: Option<String>,
    pub cookies: Vec<OriginCookies>,
}

pub struct Net {
    client: reqwest::Client,
    headers: RequestHeaders,
    retries: u32,
}

fn network(e: &reqwest::Error) -> EngineError {
    let what = if e.is_timeout() {
        "The server did not answer in time"
    } else if e.is_connect() {
        "Could not connect to the server"
    } else {
        "The connection failed"
    };
    EngineError::new(ErrorCode::Network, what)
}

fn http(status: StatusCode) -> EngineError {
    EngineError::new(ErrorCode::HttpError, format!("HTTP {}", status.as_u16()))
}

/// Worth another try: the server or the network may recover.
fn transient(e: &EngineError) -> bool {
    match e.code {
        ErrorCode::Network => true,
        ErrorCode::HttpError => {
            let code: u16 = e.message.trim_start_matches("HTTP ").parse().unwrap_or(0);
            code == 408 || code == 429 || code >= 500
        }
        _ => false,
    }
}

impl Net {
    pub fn new(headers: RequestHeaders) -> Result<Self> {
        let ua = headers
            .user_agent
            .clone()
            .unwrap_or_else(|| DEFAULT_USER_AGENT.into());
        let client = reqwest::Client::builder()
            .user_agent(ua)
            .redirect(redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("too many redirects")
                } else if matches!(attempt.url().scheme(), "http" | "https") {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| EngineError::new(ErrorCode::Unknown, format!("HTTP client: {e}")))?;
        Ok(Self {
            client,
            headers,
            retries: 3,
        })
    }

    /// The headers for one request: Referer / Origin as handed over, cookies only for their own origin.
    fn headers_for(&self, url: &url::Url) -> HeaderMap {
        let mut h = HeaderMap::new();
        let mut set = |name, value: &str| {
            if let Ok(v) = HeaderValue::from_str(value) {
                h.insert(name, v);
            }
        };
        if let Some(r) = &self.headers.referer {
            set(REFERER, r);
        }
        if let Some(o) = &self.headers.origin {
            set(ORIGIN, o);
        }
        if let Some(ua) = &self.headers.user_agent {
            set(USER_AGENT, ua);
        }
        let origin = url.origin().ascii_serialization();
        if let Some(c) = self.headers.cookies.iter().find(|c| c.origin == origin) {
            if let Ok(mut v) = HeaderValue::from_str(&c.header) {
                v.set_sensitive(true);
                h.insert(COOKIE, v);
            }
        }
        h
    }

    fn checked(url: &str) -> Result<url::Url> {
        if !is_safe_fetch_url(url) {
            return Err(EngineError::invalid(
                "Only http(s) addresses can be downloaded",
            ));
        }
        url::Url::parse(url).map_err(|_| EngineError::invalid("Not a valid address"))
    }

    async fn send_once(
        &self,
        url: &url::Url,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<Response> {
        let mut req = self.client.get(url.clone()).headers(self.headers_for(url));
        if let Some((from, len)) = range {
            let to = len.map_or(String::new(), |l| (from + l - 1).to_string());
            req = req.header(RANGE, format!("bytes={from}-{to}"));
        }
        let res = req.send().await.map_err(|e| network(&e))?;
        let status = res.status();
        if status.is_success() {
            Ok(res)
        } else if status == StatusCode::RANGE_NOT_SATISFIABLE {
            Err(EngineError::invalid("The server refused the byte range"))
        } else {
            Err(http(status))
        }
    }

    /// One GET, retried on network errors and 408 / 429 / 5xx.
    pub async fn get(&self, url: &str, range: Option<(u64, Option<u64>)>) -> Result<Response> {
        let u = Self::checked(url)?;
        let mut attempt = 0;
        loop {
            match self.send_once(&u, range).await {
                Ok(r) => return Ok(r),
                Err(e) if transient(&e) && attempt + 1 < self.retries => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(500 << attempt)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// A whole body, at most `cap` bytes.
    async fn body(res: Response, cap: usize) -> Result<Vec<u8>> {
        if res.content_length().is_some_and(|n| n > cap as u64) {
            return Err(EngineError::new(
                ErrorCode::TooLarge,
                "The response is too large",
            ));
        }
        let mut res = res;
        let mut out = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| network(&e))? {
            out.extend_from_slice(&chunk);
            if out.len() > cap {
                return Err(EngineError::new(
                    ErrorCode::TooLarge,
                    "The response is too large",
                ));
            }
        }
        Ok(out)
    }

    /// A text document (playlist, manifest) and the address it finally came from (after redirects).
    pub async fn text(&self, url: &str) -> Result<(String, String)> {
        let res = self.get(url, None).await?;
        let final_url = res.url().to_string();
        let body = Self::body(res, MAX_TEXT_BYTES).await?;
        Ok((String::from_utf8_lossy(&body).into_owned(), final_url))
    }

    /// The bytes of a segment, key or initialisation section, optionally one byte range of the resource.
    pub async fn bytes(
        &self,
        url: &str,
        range: Option<&HlsByteRange>,
        cap: usize,
    ) -> Result<Vec<u8>> {
        let Some(r) = range else {
            return Self::body(self.get(url, None).await?, cap).await;
        };
        let (offset, length) = (r.offset as u64, r.length as u64);
        let res = self.get(url, Some((offset, Some(length)))).await?;
        let partial = res.status() == StatusCode::PARTIAL_CONTENT;
        let body = Self::body(res, cap.max(offset as usize + length as usize)).await?;
        if partial {
            if body.len() as u64 != length {
                return Err(EngineError::invalid(
                    "The server returned a different byte range than requested",
                ));
            }
            return Ok(body);
        }
        // the server ignored the range and sent the whole resource
        let end = (offset + length) as usize;
        if body.len() < end {
            return Err(EngineError::invalid(
                "The server ignored the byte range and the data is too short",
            ));
        }
        Ok(body[offset as usize..end].to_vec())
    }
}

/// A URL as it may appear in a message or a log: credentials and token-like parameters removed.
pub fn shown(url: &str) -> String {
    redact_url(url)
}
