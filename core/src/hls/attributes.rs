//! Parser for HLS attribute lists, e.g. `BANDWIDTH=1000,CODECS="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720`.

use std::collections::HashMap;

use crate::js;

/// Keys are upper-cased; a later duplicate key wins.
pub fn parse_attributes(input: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut rest = input;
    loop {
        rest = rest.trim_start_matches([',', ' ', '\t']);
        let Some(eq) = rest.find('=') else { break };
        let key = js::trim(&rest[..eq]).to_uppercase();
        rest = &rest[eq + 1..];
        let value;
        if let Some(quoted) = rest.strip_prefix('"') {
            match quoted.find('"') {
                None => {
                    value = quoted.to_string();
                    rest = "";
                }
                Some(end) => {
                    value = quoted[..end].to_string();
                    rest = &quoted[end + 1..];
                }
            }
        } else {
            let end = rest.find(',').unwrap_or(rest.len());
            value = js::trim(&rest[..end]).to_string();
            rest = &rest[end..];
        }
        if !key.is_empty() {
            out.insert(key, value);
        }
        if rest.is_empty() {
            break;
        }
    }
    out
}

/// `1280x720` (any case of `x`), both sides positive.
pub fn parse_resolution(value: Option<&str>) -> Option<(f64, f64)> {
    let v = js::trim(value.filter(|v| !v.is_empty())?);
    let (w, h) = v.split_once(['x', 'X'])?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !digits(w) || !digits(h) {
        return None;
    }
    let (w, h) = (js::number(w), js::number(h));
    (w > 0.0 && h > 0.0).then_some((w, h))
}

/// `Number(value)` when finite; `None` for absent or empty.
pub fn parse_number(value: Option<&str>) -> Option<f64> {
    js::finite_number(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attributes() {
        let a = parse_attributes(
            r#"BANDWIDTH=1000, codecs="avc1.64001f,mp4a.40.2",RESOLUTION=1280x720,NAME="x"#,
        );
        assert_eq!(a["BANDWIDTH"], "1000");
        assert_eq!(a["CODECS"], "avc1.64001f,mp4a.40.2");
        assert_eq!(a["RESOLUTION"], "1280x720");
        assert_eq!(a["NAME"], "x");
        assert!(parse_attributes("garbage").is_empty());
    }

    #[test]
    fn resolution_and_numbers() {
        assert_eq!(parse_resolution(Some("1920X1080")), Some((1920.0, 1080.0)));
        assert_eq!(parse_resolution(Some("0x720")), None);
        assert_eq!(parse_resolution(Some("1920x")), None);
        assert_eq!(parse_number(Some("2.5")), Some(2.5));
        assert_eq!(parse_number(Some("")), None);
        assert_eq!(parse_number(None), None);
    }
}
