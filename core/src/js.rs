//! JavaScript semantics the TypeScript implementation relied on, reproduced exactly so the Rust core gives the same
//! answers (`Number()`, `String.prototype.trim`, `toUpperCase`).

/// Characters `String.prototype.trim` removes: ECMAScript WhiteSpace and LineTerminator.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.trimStart()`.
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// `Number(s)`: `NaN` when JavaScript would give `NaN`.
pub fn number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0.0, |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0))
            });
        }
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also accepts "inf", "nan", "infinity" (any case); JavaScript does not.
    if !t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(s)` when finite, the way the TypeScript `parseNumber` helpers used it (`''` and absent give `None`).
pub fn finite_number(s: Option<&str>) -> Option<f64> {
    let s = s?;
    if s.is_empty() {
        return None;
    }
    let n = number(s);
    n.is_finite().then_some(n)
}

/// `String(n)` for a JavaScript number (shortest round-trip digits; exponent form from 1e21 and below 1e-6).
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    if n == 0.0 {
        return "0".into();
    }
    let sci = format!("{:e}", n.abs()); // shortest digits, e.g. "1.5e21", "3e-7"
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let e: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let point = e + 1; // position of the decimal point relative to the digits
    let body = if (1..=21).contains(&point) && point >= k {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if (1..=21).contains(&point) {
        format!(
            "{}.{}",
            &digits[..point as usize],
            &digits[point as usize..]
        )
    } else if (-5..=0).contains(&point) {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let sign = if e < 0 { '-' } else { '+' };
        let m = if k == 1 {
            digits.clone()
        } else {
            format!("{}.{}", &digits[..1], &digits[1..])
        };
        format!("{m}e{sign}{}", e.abs())
    };
    if n < 0.0 { format!("-{body}") } else { body }
}

/// `Date.parse` for the ISO 8601 forms manifests use: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm[:ss[.sss]]` with `Z` or `±HH:mm`.
/// A date-time without an offset is read as UTC (JavaScript would use the local time zone, which wasm does not have).
pub fn parse_iso_date_ms(s: &str) -> Option<f64> {
    let s = trim(s);
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    let year = num(0, 4)?;
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    let (month, day) = (num(5, 2)?, num(8, 2)?);
    let days_in = |y: i64, m: i64| match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=12).contains(&month) || day < 1 || day > days_in(year, month) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms, mut offset_min) = (0, 0, 0, 0.0, 0);
    if b.len() > 10 {
        let mut i;
        if b[10] != b'T' && b[10] != b't' {
            return None;
        }
        h = num(11, 2)?;
        if b.get(13) != Some(&b':') {
            return None;
        }
        mi = num(14, 2)?;
        i = 16;
        if b.get(16) == Some(&b':') {
            sec = num(17, 2)?;
            i = 19;
            if b.get(19) == Some(&b'.') {
                let frac: String = s[20..].chars().take_while(char::is_ascii_digit).collect();
                if frac.is_empty() {
                    return None;
                }
                ms = format!("0.{frac}").parse::<f64>().ok()? * 1000.0;
                ms = ms.trunc();
                i = 20 + frac.len();
            }
        }
        if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi > 0 || sec > 0 || ms > 0.0)) {
            return None;
        }
        match b.get(i) {
            None => {}
            Some(b'Z' | b'z') if i + 1 == b.len() => {}
            Some(&sign @ (b'+' | b'-')) => {
                let oh = num(i + 1, 2)?;
                let om = if b.get(i + 3) == Some(&b':') {
                    num(i + 4, 2)?
                } else {
                    num(i + 3, 2)?
                };
                let end = if b.get(i + 3) == Some(&b':') {
                    i + 6
                } else {
                    i + 5
                };
                if end != b.len() || oh > 23 || om > 59 {
                    return None;
                }
                offset_min = (oh * 60 + om) * if sign == b'+' { 1 } else { -1 };
            }
            _ => return None,
        }
    }
    // days since 1970-01-01 (proleptic Gregorian)
    let (y, m) = if month <= 2 {
        (year - 1, month + 9)
    } else {
        (year, month - 3)
    };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs as f64 * 1000.0 + ms)
}

/// `s.length` (UTF-16 code units).
pub fn len_utf16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` in UTF-16 code units (a surrogate pair cut in half is dropped rather than split).
pub fn slice_utf16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `decodeURIComponent`; `None` where JavaScript throws (bad escapes, invalid UTF-8).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()))?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_matches_javascript() {
        let cases: &[(&str, f64)] = &[
            ("12", 12.0),
            ("  12  ", 12.0),
            ("1e3", 1000.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+5", 5.0),
            ("-5.25", -5.25),
            ("0x1F", 31.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
            ("", 0.0),
        ];
        for (s, n) in cases {
            assert_eq!(number(s), *n, "{s}");
        }
        for s in ["inf", "nan", "1_000", "1e", "0x", "-0x10", "12px", "1,5"] {
            assert!(number(s).is_nan(), "{s}");
        }
        assert_eq!(number("Infinity"), f64::INFINITY);
        assert_eq!(finite_number(Some("Infinity")), None);
        assert_eq!(finite_number(Some("")), None);
    }

    #[test]
    fn number_to_string_matches_javascript() {
        let cases: &[(f64, &str)] = &[
            (100.0, "100"),
            (1.5, "1.5"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.000001, "0.000001"),
            (1e-7, "1e-7"),
            (-2.5e-7, "-2.5e-7"),
            (-42.0, "-42"),
            (0.0, "0"),
        ];
        for (n, s) in cases {
            assert_eq!(number_to_string(*n), *s);
        }
    }

    #[test]
    fn iso_dates() {
        assert_eq!(parse_iso_date_ms("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(
            parse_iso_date_ms("2024-02-29T12:30:15.250Z"),
            Some(1_709_209_815_250.0)
        );
        assert_eq!(
            parse_iso_date_ms("2024-02-29T13:30:15.250+01:00"),
            Some(1_709_209_815_250.0)
        );
        assert_eq!(parse_iso_date_ms("2024-01-01"), Some(1_704_067_200_000.0));
        assert_eq!(parse_iso_date_ms("2023-02-29T00:00:00Z"), None);
        assert_eq!(parse_iso_date_ms("garbage"), None);
        assert_eq!(parse_iso_date_ms(""), None);
    }

    #[test]
    fn trim_matches_javascript() {
        assert_eq!(trim("\u{FEFF}\u{A0} a b \t\r\n"), "a b");
        assert_eq!(trim_start("  a "), "a ");
    }
}
