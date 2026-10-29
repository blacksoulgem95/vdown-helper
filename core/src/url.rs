//! URL helpers from `src/lib/security.ts` (WHATWG parsing, like `new URL()`).

/// The longest address the extension will fetch. Real signed URLs stay well below this; a manifest cannot make it grow.
pub const MAX_URL_LENGTH: usize = 8192;

/// `new URL(input)` or `new URL(input, base)`, `None` instead of throwing.
pub fn parse_url(input: &str, base: Option<&str>) -> Option<url::Url> {
    match base {
        None => url::Url::parse(input).ok(),
        Some(b) => url::Url::parse(b).ok()?.join(input).ok(),
    }
}

/// `url.host`: the host name plus a port that is not the scheme's default.
pub fn host(u: &url::Url) -> String {
    let h = u.host_str().unwrap_or("");
    u.port()
        .map_or_else(|| h.to_string(), |p| format!("{h}:{p}"))
}

/// `url.origin` of an http(s) URL (`scheme://host[:port]`).
pub fn origin(u: &url::Url) -> String {
    u.origin().ascii_serialization()
}

/// True for http(s) URLs only. Everything else (javascript:, data:, file:, chrome:, ftp:, blob: ...) is rejected.
pub fn is_safe_fetch_url(input: &str) -> bool {
    // JavaScript counts UTF-16 code units.
    if input.encode_utf16().count() > MAX_URL_LENGTH {
        return false;
    }
    parse_url(input, None).is_some_and(|u| matches!(u.scheme(), "http" | "https"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_fetch_urls() {
        assert!(is_safe_fetch_url("https://a.example/x.m3u8"));
        assert!(is_safe_fetch_url("HTTP://A.example/"));
        for bad in [
            "javascript:alert(1)",
            "data:text/plain,x",
            "file:///etc/passwd",
            "blob:https://a/x",
            "ftp://a/",
        ] {
            assert!(!is_safe_fetch_url(bad), "{bad}");
        }
        assert!(!is_safe_fetch_url(&format!(
            "https://a.example/{}",
            "a".repeat(MAX_URL_LENGTH)
        )));
    }

    #[test]
    fn relative_resolution() {
        let u = parse_url("../b/c.ts?x=1", Some("https://h.example/a/p/index.m3u8"))
            .map(|u| u.to_string());
        assert_eq!(u.as_deref(), Some("https://h.example/a/b/c.ts?x=1"));
    }
}
