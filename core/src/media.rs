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
