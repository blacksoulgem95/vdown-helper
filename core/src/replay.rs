//! Header replay from `src/lib/replay.ts`: only the Referer and Origin the browser itself sent for the frame that owns a
//! stream, and only on the hosts of the job's own URLs. (The `declarativeNetRequest` rule itself is built by the
//! extension.)

use serde::Serialize;

use crate::url::{origin, parse_url};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplayHeaders {
    /// The origin plus "/" (the browser's default strict-origin-when-cross-origin form, which leaks the least).
    pub referer: String,
    pub origin: String,
}

pub fn replay_headers_for(frame_url: Option<&str>) -> Option<ReplayHeaders> {
    let u = parse_url(frame_url.filter(|f| !f.is_empty())?, None)?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let o = origin(&u);
    Some(ReplayHeaders {
        referer: format!("{o}/"),
        origin: o,
    })
}

/// Host names a rule may apply to: only those of this job's own http(s) URLs (at most `max`), never "everything".
pub fn replay_domains<'a>(urls: impl IntoIterator<Item = &'a str>, max: usize) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for url in urls {
        if let Some(u) = parse_url(url, None).filter(|u| matches!(u.scheme(), "http" | "https")) {
            let h = u.host_str().unwrap_or("").to_string();
            if !hosts.contains(&h) {
                hosts.push(h);
            }
        }
        if hosts.len() >= max {
            break;
        }
    }
    hosts
}

/// Deterministic rule id in a private range, so a job's rule can be found (and removed) after a worker restart.
pub fn rule_id_for(job_id: &str) -> u32 {
    1_000_000 + crate::js::fnv1a_utf16(job_id) % 900_000_000
}
