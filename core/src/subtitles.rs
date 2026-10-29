//! Subtitles from `src/lib/subtitles.ts` and `src/lib/subtitleBytes.ts`: WebVTT, SRT and TTML read into cues (also from
//! the bytes of a segmented stream, including TTML carried in MP4), and written back as SRT or WebVTT.
//!
//! The TypeScript used regular expressions; each one is reproduced by a small scanner, and the golden fixtures hold
//! both to the same answers.

use serde::{Deserialize, Serialize};

use crate::js::{is_js_space, round, slice_utf16, to_fixed, trim, trim_start};
use crate::xml::{XmlContent, XmlLimits, XmlNode, decode_entities, local_name, parse_xml};

/// A single caption. Times are seconds on the media timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    /// Plain text with `<b>`/`<i>`/`<u>` kept (SRT-compatible); lines separated by "\n".
    pub text: String,
}

const MAX_CUES: usize = 100_000;

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{FEFF}').unwrap_or(s)
}

/// The maximal run of ASCII digits at the start of `s`.
fn digits(s: &str) -> &str {
    &s[..s.bytes().take_while(u8::is_ascii_digit).count()]
}

/// `<` + `\s` or `>` (or the end of a `[\s>:]` class when `colon` is allowed).
fn tag_end(c: Option<char>, colon: bool) -> bool {
    c.is_some_and(|c| is_js_space(c) || c == '>' || (colon && c == ':'))
}

/// `/^<\?xml|^<tt[\s>:]|^<[a-z0-9]+:tt[\s>]/i`
fn starts_like_ttml(t: &str) -> bool {
    let lower = t.get(..5).map(str::to_ascii_lowercase);
    if lower.as_deref() == Some("<?xml") {
        return true;
    }
    let Some(rest) = t.strip_prefix('<') else {
        return false;
    };
    if rest.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("tt"))
        && tag_end(rest[2..].chars().next(), true)
    {
        return true;
    }
    let run = rest.bytes().take_while(u8::is_ascii_alphanumeric).count();
    run > 0
        && rest[run..]
            .get(..3)
            .is_some_and(|p| p.eq_ignore_ascii_case(":tt"))
        && tag_end(rest[run + 3..].chars().next(), false)
}

/// `/<(\w+:)?tt[\s>]/` anywhere in `s` (case-sensitive).
fn has_tt_element(s: &str) -> bool {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    s.match_indices('<').any(|(i, _)| {
        let rest = &s[i + 1..];
        if rest.starts_with("tt") && tag_end(rest[2..].chars().next(), false) {
            return true;
        }
        let run = rest.bytes().take_while(|b| word(*b)).count();
        run > 0 && rest[run..].starts_with(":tt") && tag_end(rest[run + 3..].chars().next(), false)
    })
}

/// `/^\d+\s*\r?\n\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/`
fn starts_like_srt(t: &str) -> bool {
    let n = digits(t).len();
    if n == 0 {
        return false;
    }
    let rest = &t[n..];
    let ws = rest.len() - rest.trim_start_matches(is_js_space).len();
    if ws == 0 || !rest[..ws].ends_with('\n') {
        return false;
    }
    let rest = &rest[ws..];
    let fields = [(1, 2), (2, 2), (2, 2)];
    let mut at = rest;
    for (k, (min, max)) in fields.iter().enumerate() {
        let d = digits(at).len();
        if d < *min || d > *max {
            return false;
        }
        at = &at[d..];
        let sep = at.chars().next();
        let ok = if k < 2 {
            sep == Some(':')
        } else {
            matches!(sep, Some(',' | '.'))
        };
        if !ok {
            return false;
        }
        at = &at[1..];
    }
    let d = digits(at).len();
    (1..=3).contains(&d) && trim_start(&at[d..]).starts_with("-->")
}

/// Best guess of what a document is, from its content (never from its name).
pub fn detect_subtitle_format(text: &str) -> &'static str {
    let t = trim_start(strip_bom(text));
    if t.starts_with("WEBVTT") {
        "vtt"
    } else if starts_like_ttml(t) && has_tt_element(slice_utf16(t, 2000)) {
        "ttml"
    } else if starts_like_srt(t) {
        "srt"
    } else {
        "unknown"
    }
}

// ---------------------------------------------------------------------------------------------------------------
// WebVTT

/// "01:02:03.456", "02:03.456" or SRT's "01:02:03,456" to seconds.
pub fn parse_timestamp(value: &str) -> Option<f64> {
    let v = trim(value);
    let sep = v.find(['.', ','])?;
    let (clock, frac) = (&v[..sep], &v[sep + 1..]);
    if frac.is_empty() || frac.len() > 3 || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parts: Vec<&str> = clock.split(':').collect();
    let all_digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let (h, m, s) = match parts.as_slice() {
        [m, s] => ("0", *m, *s),
        [h, m, s] if all_digits(h) => (*h, *m, *s),
        _ => return None,
    };
    if !all_digits(m) || m.len() > 2 || s.len() != 2 || !all_digits(s) {
        return None;
    }
    let n = |p: &str| crate::js::number(p);
    let ms = n(&format!("{frac:0<3}"));
    Some(n(h) * 3600.0 + n(m) * 60.0 + n(s) + ms / 1000.0)
}

/// `/^\s*(\S+)\s+-->\s+(\S+)/`: the two times of a cue timing line.
fn timing(line: &str) -> Option<(&str, &str)> {
    let s = trim_start(line);
    let a = s.find(is_js_space).filter(|n| *n > 0)?;
    let (first, rest) = s.split_at(a);
    let rest = trim_start(rest);
    let rest = rest.strip_prefix("-->")?;
    let after = trim_start(rest);
    if after.len() == rest.len() {
        return None;
    }
    let b = after.find(is_js_space).unwrap_or(after.len());
    (b > 0).then(|| (first, &after[..b]))
}

/// Applies `step` at every position: it returns how many bytes it consumed and what to write, or `None` to copy one
/// character (a global regular-expression replace).
fn replace_all(s: &str, mut step: impl FnMut(&str) -> Option<(usize, String)>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some((n, with)) = step(&s[i..]) {
            out.push_str(&with);
            i += n.max(1);
        } else {
            let c = s[i..].chars().next().unwrap_or(' ');
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// `<` `/`? then one of `names` (ASCII case-insensitive), then `(?:[sep][^>]*)?>`. Returns the bytes matched, the slash
/// and the name as written.
fn tag<'a>(
    s: &'a str,
    names: &[&str],
    sep: impl Fn(char) -> bool,
) -> Option<(usize, &'a str, &'a str)> {
    let rest = s.strip_prefix('<')?;
    let slash = if rest.starts_with('/') { "/" } else { "" };
    let rest = &rest[slash.len()..];
    for name in names {
        let Some(written) = rest
            .get(..name.len())
            .filter(|w| w.eq_ignore_ascii_case(name))
        else {
            continue;
        };
        let after = &rest[name.len()..];
        let len = 1 + slash.len() + name.len();
        match after.chars().next() {
            Some('>') => return Some((len + 1, slash, written)),
            Some(c) if sep(c) => {
                if let Some(close) = after.find('>') {
                    return Some((len + close + 1, slash, written));
                }
            }
            _ => {}
        }
    }
    None
}

/// `<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>` (a karaoke timestamp).
fn karaoke(s: &str) -> Option<usize> {
    let mut at = s.strip_prefix('<')?;
    let d = digits(at).len();
    if !(1..=2).contains(&d) {
        return None;
    }
    at = at[d..].strip_prefix(':')?;
    if digits(at).len() != 2 {
        return None;
    }
    at = &at[2..];
    if let Some(r) = at.strip_prefix(':') {
        if digits(r).len() != 2 {
            return None;
        }
        at = &r[2..];
    }
    at = at.strip_prefix(['.', ','])?;
    let d = digits(at).len();
    if !(1..=3).contains(&d) {
        return None;
    }
    at[d..].starts_with('>').then(|| s.len() - at.len() + d + 1)
}

/// `</?[biu]>` in lower case.
fn simple_style(s: &str) -> Option<usize> {
    let r = s.strip_prefix('<')?;
    let r2 = r.strip_prefix('/').unwrap_or(r);
    let b = r2.as_bytes();
    (b.len() >= 2 && matches!(b[0], b'b' | b'i' | b'u') && b[1] == b'>')
        .then(|| s.len() - r2.len() + 2)
}

/// WebVTT inline markup reduced to the small SRT-safe subset.
fn clean_vtt_text(raw: &str) -> String {
    let s = replace_all(raw, |s| {
        tag(s, &["b", "i", "u"], |c| c == '.')
            .map(|(n, slash, name)| (n, format!("<{slash}{name}>")))
    });
    let s = replace_all(&s, |s| {
        tag(s, &["c", "v", "lang", "ruby", "rt", "rp"], |c| {
            c == '.' || is_js_space(c)
        })
        .map(|(n, _, _)| (n, String::new()))
    });
    let s = replace_all(&s, |s| karaoke(s).map(|n| (n, String::new())));
    let s = replace_all(&s, |s| {
        if !s.starts_with('<') || simple_style(s).is_some() {
            return None;
        }
        s.find('>').map(|close| (close + 1, String::new()))
    });
    decode_entities(&s.replace("&nbsp;", " "))
}

/// Lines split on CRLF, LF or CR.
fn lines(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'\r' => {
                out.push(&text[start..i]);
                i += if b.get(i + 1) == Some(&b'\n') { 2 } else { 1 };
                start = i;
            }
            b'\n' => {
                out.push(&text[start..i]);
                i += 1;
                start = i;
            }
            _ => i += 1,
        }
    }
    out.push(&text[start..]);
    out
}

/// `/^(NOTE|STYLE|REGION)(\s|$)/`
fn is_block_header(line: &str) -> bool {
    ["NOTE", "STYLE", "REGION"].iter().any(|h| {
        line.strip_prefix(h)
            .is_some_and(|r| r.chars().next().is_none_or(is_js_space))
    })
}

pub fn parse_vtt(text: &str) -> Vec<Cue> {
    let lines = lines(strip_bom(text));
    let blank = |l: &str| trim(l).is_empty();
    let mut cues = Vec::new();
    let mut i = 0;
    while i < lines.len() && !lines[i].starts_with("WEBVTT") {
        i += 1;
    }
    i += 1;
    while i < lines.len() {
        let line = lines[i];
        if blank(line) {
            i += 1;
            continue;
        }
        // Skip NOTE / STYLE / REGION blocks.
        if is_block_header(line) {
            while i < lines.len() && !blank(lines[i]) {
                i += 1;
            }
            continue;
        }
        // Optional cue identifier line, then the timing line.
        let mut t = timing(line);
        if t.is_none()
            && i + 1 < lines.len()
            && let Some(next) = timing(lines[i + 1])
        {
            t = Some(next);
            i += 1;
        }
        let Some((a, b)) = t else {
            i += 1;
            continue;
        };
        i += 1;
        let (start, end) = (parse_timestamp(a), parse_timestamp(b));
        let mut body = Vec::new();
        while i < lines.len() && !blank(lines[i]) {
            body.push(lines[i]);
            i += 1;
        }
        let (Some(start), Some(end)) = (start, end) else {
            continue;
        };
        if end < start {
            continue;
        }
        let text = trim(&clean_vtt_text(&body.join("\n"))).to_string();
        if !text.is_empty() {
            cues.push(Cue { start, end, text });
        }
        if cues.len() >= MAX_CUES {
            break;
        }
    }
    cues
}

/// `KEY:` followed by a run of `class` characters, searched from the start of `s`: the run and what follows it.
fn find_field<'a>(s: &'a str, key: &str, class: fn(u8) -> bool) -> Option<(&'a str, &'a str)> {
    s.match_indices(key).find_map(|(i, _)| {
        let rest = &s[i + key.len()..];
        let n = rest.bytes().take_while(|b| class(*b)).count();
        (n > 0).then(|| (&rest[..n], &rest[n..]))
    })
}

/// The `X-TIMESTAMP-MAP` of a WebVTT segment: seconds to add to cue times to get media (MPEG-TS) time.
pub fn timestamp_map_offset(text: &str) -> Option<f64> {
    let head = slice_utf16(text, 2000);
    let ts = |b: u8| b.is_ascii_digit();
    let local = |b: u8| b.is_ascii_digit() || b == b':' || b == b'.';
    let found = head
        .match_indices("X-TIMESTAMP-MAP=")
        .find_map(|(i, key)| {
            let line = &head[i + key.len()..];
            let line = &line[..line.find(['\r', '\n']).unwrap_or(line.len())];
            if let Some((mpegts, rest)) = find_field(line, "MPEGTS:", ts)
                && let Some((l, _)) = find_field(rest, "LOCAL:", local)
            {
                return Some((mpegts, l));
            }
            let (l, rest) = find_field(line, "LOCAL:", local)?;
            let (mpegts, _) = find_field(rest, "MPEGTS:", ts)?;
            Some((mpegts, l))
        })?;
    let mpegts = crate::js::number(found.0);
    let local = parse_timestamp(found.1)?;
    mpegts.is_finite().then(|| mpegts / 90000.0 - local)
}

fn cue_key(c: &Cue) -> String {
    format!("{}|{}|{}", to_fixed(c.start, 3), to_fixed(c.end, 3), c.text)
}

fn sort_cues(cues: &mut [Cue]) {
    cues.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.end
                    .partial_cmp(&b.end)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
}

/// Join the segments of an HLS WebVTT subtitle playlist into one cue list. With X-TIMESTAMP-MAP the cues are moved onto
/// the media timeline and shifted so the earliest segment starts at zero; without it cue times are already absolute
/// (RFC 8216). Cues repeated at segment boundaries are removed.
pub fn stitch_vtt_segments<S: AsRef<str>>(segments: &[S]) -> Vec<Cue> {
    let offsets: Vec<Option<f64>> = segments
        .iter()
        .map(|s| timestamp_map_offset(s.as_ref()))
        .collect();
    let base = offsets
        .iter()
        .flatten()
        .copied()
        .reduce(f64::min)
        .unwrap_or(0.0);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (seg, off) in segments.iter().zip(&offsets) {
        let shift = off.unwrap_or(base) - base;
        for c in parse_vtt(seg.as_ref()) {
            let cue = Cue {
                start: c.start + shift,
                end: c.end + shift,
                text: c.text,
            };
            if seen.insert(cue_key(&cue)) {
                out.push(cue);
            }
        }
    }
    sort_cues(&mut out);
    out.truncate(MAX_CUES);
    out
}

// ---------------------------------------------------------------------------------------------------------------
// TTML

fn ttml_time(value: Option<&str>, frame_rate: f64, tick_rate: f64) -> Option<f64> {
    let v = trim(value.filter(|v| !v.is_empty())?);
    let n = crate::js::number;
    let all = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let parts: Vec<&str> = v.split(':').collect();
    if let [h, m, s] = parts.as_slice() {
        // hh:mm:ss(.fraction)
        let (s, frac) = s.split_once('.').map_or((*s, None), |(a, b)| (a, Some(b)));
        if all(h) && m.len() == 2 && all(m) && s.len() == 2 && all(s) && frac.is_none_or(all) {
            return Some(
                n(h) * 3600.0 + n(m) * 60.0 + n(s) + frac.map_or(0.0, |f| n(&format!("0.{f}"))),
            );
        }
        return None;
    }
    if let [h, m, s, f] = parts.as_slice() {
        // hh:mm:ss:frames(.subframes)
        let f = f
            .split_once('.')
            .map_or(Some(*f), |(a, b)| all(b).then_some(a));
        if let Some(f) = f.filter(|f| all(f))
            && all(h)
            && m.len() == 2
            && all(m)
            && s.len() == 2
            && all(s)
        {
            return Some(n(h) * 3600.0 + n(m) * 60.0 + n(s) + n(f) / frame_rate);
        }
        return None;
    }
    // 1.5s, 200ms, 10f, 3000t, 1h, 2m
    let unit_at = v.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (num, unit) = v.split_at(unit_at);
    let (int, frac) = num
        .split_once('.')
        .map_or((num, None), |(a, b)| (a, Some(b)));
    if !all(int) || frac.is_some_and(|f| !all(f)) {
        return None;
    }
    let x = n(num);
    Some(match unit {
        "h" => x * 3600.0,
        "m" => x * 60.0,
        "s" => x,
        "ms" => x / 1000.0,
        "f" => x / frame_rate,
        "t" => x / tick_rate,
        _ => return None,
    })
}

/// Text of a `<p>`: character data and `<span>`s in document order, `<br/>` as a line break.
fn ttml_text(node: &XmlNode) -> String {
    let mut out = String::new();
    for part in &node.content {
        match part {
            XmlContent::Text(t) => out.push_str(t),
            XmlContent::Child(i) => {
                let c = &node.children[*i];
                match local_name(&c.name) {
                    "br" => out.push('\n'),
                    "span" => out.push_str(&ttml_text(c)),
                    _ => {}
                }
            }
        }
    }
    out
}

/// `.replace(/[ \t\r]+/g, ' ').replace(/ ?\n ?/g, '\n').trim()`
fn tidy_lines(s: &str) -> String {
    let mut one = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, ' ' | '\t' | '\r') {
            if !one.ends_with(' ') {
                one.push(' ');
            }
        } else {
            one.push(c);
        }
    }
    let out = replace_all(&one, |s| {
        let b = s.as_bytes();
        let lead = usize::from(b.first() == Some(&b' '));
        if b.get(lead) != Some(&b'\n') {
            return None;
        }
        let trail = usize::from(b.get(lead + 1) == Some(&b' '));
        Some((lead + 1 + trail, "\n".to_string()))
    });
    trim(&out).to_string()
}

fn rate(root: &XmlNode, name: &str, fallback: f64) -> f64 {
    let v = root
        .attrs
        .iter()
        .find(|(k, _)| local_name(k) == name)
        .map_or(f64::NAN, |(_, v)| crate::js::number(v));
    if v == 0.0 || v.is_nan() { fallback } else { v }
}

pub fn parse_ttml(text: &str) -> Vec<Cue> {
    let Some(root) = parse_xml(text, XmlLimits::default()) else {
        return Vec::new();
    };
    if local_name(&root.name) != "tt" {
        return Vec::new();
    }
    let frame_rate = rate(&root, "frameRate", 30.0);
    let tick_rate = rate(&root, "tickRate", 10_000_000.0);
    let mut cues = Vec::new();
    visit(&root, 0.0, frame_rate, tick_rate, &mut cues);
    cues.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    cues
}

fn visit(node: &XmlNode, inherit: f64, frame_rate: f64, tick_rate: f64, cues: &mut Vec<Cue>) {
    let ln = local_name(&node.name);
    let time = |k: &str| ttml_time(node.attrs.get(k), frame_rate, tick_rate);
    let begin = time("begin");
    let base = inherit + begin.unwrap_or(0.0);
    if ln == "p" {
        let start = begin.map_or(inherit, |b| inherit + b);
        let end = match (time("end"), time("dur")) {
            (Some(e), _) => Some(inherit + e),
            (None, Some(d)) => Some(start + d),
            _ => None,
        };
        let body = tidy_lines(&ttml_text(node));
        if let Some(end) = end
            && end >= start
            && !body.is_empty()
            && cues.len() < MAX_CUES
        {
            cues.push(Cue {
                start,
                end,
                text: body,
            });
        }
        return;
    }
    let next = if ln == "div" || ln == "body" {
        base
    } else {
        inherit
    };
    for c in &node.children {
        visit(c, next, frame_rate, tick_rate, cues);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Output

fn srt_time(sec: f64) -> String {
    let ms = round(sec.max(0.0) * 1000.0);
    let h = (ms / 3_600_000.0).floor();
    let m = ((ms % 3_600_000.0) / 60_000.0).floor();
    let s = ((ms % 60_000.0) / 1000.0).floor();
    let p = |n: f64, w: usize| format!("{:0>w$}", crate::js::number_to_string(n));
    format!("{}:{}:{},{}", p(h, 2), p(m, 2), p(s, 2), p(ms % 1000.0, 3))
}

pub fn format_srt(cues: &[Cue]) -> String {
    cues.iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                srt_time(c.start),
                srt_time(c.end),
                c.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn vtt_time(sec: f64) -> String {
    srt_time(sec).replacen(',', ".", 1)
}

/// WebVTT cue text: keep `<b>`/`<i>`/`<u>`, escape everything else that WebVTT would read as markup.
fn vtt_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if let Some(n) = simple_style(rest) {
            out.push_str(&rest[..n]);
            i += n;
            continue;
        }
        let c = rest.chars().next().unwrap_or(' ');
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            c => out.push(c),
        }
        i += c.len_utf8();
    }
    // a blank line would end the cue
    let mut squeezed = String::with_capacity(out.len());
    for c in out.chars() {
        if c == '\n' && squeezed.ends_with('\n') {
            continue;
        }
        squeezed.push(c);
    }
    squeezed.replace("-->", "--&gt;")
}

pub fn format_vtt(cues: &[Cue]) -> String {
    let body = cues
        .iter()
        .map(|c| {
            format!(
                "{} --> {}\n{}\n",
                vtt_time(c.start),
                vtt_time(c.end),
                vtt_escape(&c.text)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("WEBVTT\n\n{body}")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Parsed {
    pub format: &'static str,
    pub cues: Vec<Cue>,
}

/// `.replace(/(\d),(\d{3})/g, '$1.$2')`: SRT's decimal comma.
fn srt_commas(s: &str) -> String {
    replace_all(s, |s| {
        let b = s.as_bytes();
        (b.len() >= 5
            && b[0].is_ascii_digit()
            && b[1] == b','
            && b[2..5].iter().all(u8::is_ascii_digit))
        .then(|| (5, format!("{}.{}", &s[..1], &s[2..5])))
    })
}

/// Any supported subtitle document as cues (SRT is read by the WebVTT reader: same layout).
pub fn parse_subtitles(text: &str) -> Parsed {
    let format = detect_subtitle_format(text);
    let cues = match format {
        "vtt" => parse_vtt(text),
        "srt" => parse_vtt(&format!("WEBVTT\n\n{}", srt_commas(strip_bom(text)))),
        "ttml" => parse_ttml(text),
        _ => Vec::new(),
    };
    Parsed { format, cues }
}

pub fn to_srt(text: &str) -> Option<String> {
    let cues = parse_subtitles(text).cues;
    (!cues.is_empty()).then(|| format_srt(&cues))
}

// ---------------------------------------------------------------------------------------------------------------
// Bytes

/// Windows-1252 as the WHATWG Encoding Standard decodes it (0x80-0x9F mostly typographic marks).
const CP1252: [char; 32] = [
    '\u{20AC}', '\u{81}', '\u{201A}', '\u{192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{2C6}', '\u{2030}', '\u{160}', '\u{2039}', '\u{152}', '\u{8D}', '\u{17D}', '\u{8F}',
    '\u{90}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{2DC}', '\u{2122}', '\u{161}', '\u{203A}', '\u{153}', '\u{9D}', '\u{17E}', '\u{178}',
];

/// Subtitle bytes as text: UTF-8 when valid (a leading BOM dropped, as `TextDecoder` does), otherwise Windows-1252
/// (the usual legacy encoding of SRT files).
pub fn decode_subtitle_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => strip_bom(s).to_string(),
        Err(_) => bytes
            .iter()
            .map(|&b| match b {
                0x80..=0x9F => CP1252[usize::from(b - 0x80)],
                _ => char::from(b),
            })
            .collect(),
    }
}

/// Payloads of the top-level `mdat` boxes of an ISO BMFF file (subtitles carried in MP4, IMSC1 `stpp`, keep their XML
/// there). Malformed or truncated boxes end the walk; they never fail.
pub fn mdat_payloads(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    let len = data.len();
    while pos + 8 <= len {
        let mut size = u64::from(u32::from_be_bytes([
            data[pos],
            data[pos + 1],
            data[pos + 2],
            data[pos + 3],
        ]));
        let ty = &data[pos + 4..pos + 8];
        let mut header = 8u64;
        if size == 1 {
            if pos + 16 > len {
                break;
            }
            let mut big = [0u8; 8];
            big.copy_from_slice(&data[pos + 8..pos + 16]);
            size = u64::from_be_bytes(big);
            if size > 9_007_199_254_740_991 {
                break;
            }
            header = 16;
        } else if size == 0 {
            size = (len - pos) as u64; // the box runs to the end of the file
        }
        if size < header {
            break;
        }
        let end = (pos as u64).saturating_add(size).min(len as u64) as usize;
        if ty == b"mdat" {
            out.push(&data[pos + header as usize..end]);
        }
        let Some(next) = (pos as u64).checked_add(size) else {
            break;
        };
        if next > len as u64 {
            break;
        }
        pos = next as usize;
    }
    out
}

/// An `mdat` can hold several concatenated TTML documents (one per sample): split after each `</tt>` or `</x:tt>`.
fn split_ttml_documents(text: &str) -> Vec<&str> {
    let mut cuts = Vec::new();
    for (k, _) in text.match_indices("tt>") {
        let before = &text[..k];
        let closes = before.ends_with("</")
            || before.strip_suffix(':').is_some_and(|b| {
                let run = b
                    .bytes()
                    .rev()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
                    .count();
                run > 0 && b[..b.len() - run].ends_with("</")
            });
        if closes {
            cuts.push(k + 3);
        }
    }
    let mut out = Vec::new();
    let mut start = 0;
    for c in cuts.into_iter().chain(std::iter::once(text.len())) {
        let piece = trim(&text[start..c]);
        if !piece.is_empty() {
            out.push(piece);
        }
        start = c;
    }
    out
}

/// Cues of one fetched subtitle resource: a text document, or an MP4 segment that carries TTML.
pub fn cues_from_bytes(bytes: &[u8]) -> Vec<Cue> {
    let head = decode_subtitle_bytes(&bytes[..bytes.len().min(2048)]);
    if detect_subtitle_format(&head) != "unknown" {
        return parse_subtitles(&decode_subtitle_bytes(bytes)).cues;
    }
    let mut cues = Vec::new();
    for payload in mdat_payloads(bytes) {
        let text = decode_subtitle_bytes(payload);
        for doc in split_ttml_documents(&text) {
            cues.extend(parse_ttml(doc));
        }
    }
    cues
}

/// Join the pieces of a segmented subtitle stream into one cue list. WebVTT pieces are placed with their
/// X-TIMESTAMP-MAP; other pieces carry absolute times. Repeated cues (segment overlap) are dropped.
pub fn assemble_cues<B: AsRef<[u8]>>(parts: &[B]) -> Vec<Cue> {
    let all_vtt = !parts.is_empty()
        && parts.iter().all(|p| {
            let p = p.as_ref();
            let t = decode_subtitle_bytes(&p[..p.len().min(64)]);
            trim_start(strip_bom(&t)).starts_with("WEBVTT")
        });
    if all_vtt {
        let texts: Vec<String> = parts
            .iter()
            .map(|p| decode_subtitle_bytes(p.as_ref()))
            .collect();
        return stitch_vtt_segments(&texts);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for part in parts {
        for c in cues_from_bytes(part.as_ref()) {
            if seen.insert(cue_key(&c)) {
                out.push(c);
            }
        }
    }
    sort_cues(&mut out);
    out.truncate(MAX_CUES);
    out
}
