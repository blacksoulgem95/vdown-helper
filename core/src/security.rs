//! URL checks, redaction and file names (`src/lib/security.ts`). Pure functions; the parts that need `chrome.*` (own
//! pages, own blob URLs, the console logger) stay in TypeScript.

use unicode_normalization::UnicodeNormalization;

use crate::js::{self, is_js_space};
use crate::url::parse_url;

pub use crate::url::{MAX_URL_LENGTH, is_safe_fetch_url};

/// True for loopback, private (RFC 1918), link-local, unique-local and "local network" host names.
pub fn is_private_host(hostname: &str) -> bool {
    let lower = hostname.to_lowercase();
    let h = lower.strip_prefix('[').unwrap_or(&lower);
    let h = h.strip_suffix(']').unwrap_or(h);
    let h = h.strip_suffix('.').unwrap_or(h);
    if h == "localhost"
        || [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
            .iter()
            .any(|s| h.ends_with(s))
    {
        return true;
    }
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
    {
        let a: u32 = parts[0].parse().unwrap_or(0);
        let b: u32 = parts[1].parse().unwrap_or(0);
        return a == 10
            || a == 127
            || a == 0
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 100 && (64..=127).contains(&b));
    }
    if h.contains(':') {
        let fe = h.starts_with("fe") && h[2..].starts_with(['8', '9', 'a', 'b']);
        return h == "::1"
            || h == "::"
            || h.starts_with("fc")
            || h.starts_with("fd")
            || fe
            || h.starts_with("::ffff:");
    }
    !h.contains('.') // single-label intranet names
}

/// `new URL(u).hostname`.
fn hostname(u: &url::Url) -> String {
    u.host_str().unwrap_or("").to_string()
}

/// Whether the extension itself may fetch `target` on behalf of the page at `page_url`: private-network targets are
/// only allowed when the page is itself on a private host (a local media server the user is browsing).
pub fn may_extension_fetch(target: &str, page_url: &str) -> bool {
    let Some(t) = parse_url(target, None) else {
        return false;
    };
    if !matches!(t.scheme(), "http" | "https") {
        return false;
    }
    if !is_private_host(&hostname(&t)) {
        return true;
    }
    parse_url(page_url, None).is_some_and(|p| is_private_host(&hostname(&p)))
}

pub fn is_blob_url(input: &str) -> bool {
    parse_url(input, None).is_some_and(|u| u.scheme() == "blob")
}

/// Canonical form used for deduplication: no fragment, no userinfo, default port dropped, query parameters sorted (by
/// code point). The path is left untouched because paths are case/slash sensitive.
pub fn normalize_url(input: &str) -> String {
    let Some(mut u) = parse_url(input, None) else {
        return js::trim(input).to_string();
    };
    u.set_fragment(None);
    // These fail only for URLs that cannot have credentials (data:, mailto:), which have none to remove.
    let _ = u.set_username("");
    let _ = u.set_password(None);
    let mut params: Vec<(String, String)> = u
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    params.sort_by(|(a, av), (b, bv)| if a == b { av.cmp(bv) } else { a.cmp(b) });
    u.set_query(None);
    if !params.is_empty() {
        u.query_pairs_mut().extend_pairs(params);
    }
    u.to_string()
}

/// `new URL(u).host`: host name plus a non-default port.
fn host_with_port(u: &url::Url) -> String {
    match u.port() {
        Some(p) => format!("{}:{p}", u.host_str().unwrap_or("")),
        None => u.host_str().unwrap_or("").to_string(),
    }
}

/// Never log full URLs: query strings and fragments often carry signed tokens.
pub fn redact_url(input: &str) -> String {
    // A data: URL is its own payload: show only the media type.
    if input.len() >= 5 && input[..5].eq_ignore_ascii_case("data:") {
        let rest = &input[5..];
        let kind = rest.split([';', ',']).next().unwrap_or("");
        return format!("data:{}", js::slice_utf16(kind, 100));
    }
    let Some(u) = parse_url(input, None) else {
        return "[invalid-url]".to_string();
    };
    let query = if u.query().is_some_and(|q| !q.is_empty()) {
        "?…"
    } else {
        ""
    };
    format!("{}://{}{}{query}", u.scheme(), host_with_port(&u), u.path())
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Replace any URL embedded in free text with its redacted form.
pub fn redact_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        let at_boundary =
            !prev.is_some_and(is_word_char) && rest.chars().next().is_some_and(is_word_char);
        let scheme_len = if at_boundary {
            ["https://", "http://", "blob://"]
                .iter()
                .find(|s| {
                    rest.len() >= s.len()
                        && rest.is_char_boundary(s.len())
                        && rest[..s.len()].eq_ignore_ascii_case(s)
                })
                .map(|s| s.len())
        } else {
            None
        };
        if let Some(sl) = scheme_len {
            let body: usize = rest[sl..]
                .chars()
                .take_while(|c| !is_js_space(*c) && !matches!(c, '"' | '\'' | '<' | '>' | ')'))
                .map(char::len_utf8)
                .sum();
            if body > 0 {
                let m = &rest[..sl + body];
                let m = if m.len() >= 5 && m[..5].eq_ignore_ascii_case("blob:") {
                    &m[5..]
                } else {
                    m
                };
                out.push_str(&redact_url(m));
                prev = rest[..sl + body].chars().last();
                i += sl + body;
                continue;
            }
        }
        let c = rest.chars().next().unwrap_or(' ');
        out.push(c);
        prev = Some(c);
        i += c.len_utf8();
    }
    out
}

fn is_illegal(c: char) -> bool {
    matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        || ('\u{0000}'..='\u{001f}').contains(&c)
        || ('\u{007f}'..='\u{009f}').contains(&c)
        || ('\u{200b}'..='\u{200f}').contains(&c)
        || ('\u{202a}'..='\u{202e}').contains(&c)
        || ('\u{2066}'..='\u{2069}').contains(&c)
        || c == '\u{FEFF}'
}

fn is_reserved_windows(name: &str) -> bool {
    let n = name.to_lowercase();
    matches!(n.as_str(), "con" | "prn" | "aux" | "nul")
        || ((n.starts_with("com") || n.starts_with("lpt"))
            && n.len() == 4
            && matches!(n.as_bytes()[3], b'1'..=b'9'))
}

/// `name.replace(/\s*:\s+/g, ' - ')`: "Live: the show" reads better as "Live - the show".
fn colon_to_dash(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut kept = 0; // bytes of `out` a later match may not take back
    let mut chars = name.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':' && chars.peek().is_some_and(|n| is_js_space(*n)) {
            let trimmed = out[kept..].trim_end_matches(is_js_space).len() + kept;
            out.truncate(trimmed);
            out.push_str(" - ");
            while chars.peek().is_some_and(|n| is_js_space(*n)) {
                chars.next();
            }
            kept = out.len();
        } else {
            out.push(c);
        }
    }
    out
}

/// Collapse every run of `pred` characters to `with`.
fn collapse(s: &str, pred: impl Fn(char) -> bool, with: &str, min_run: usize) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    for c in s.chars() {
        if pred(c) {
            run.push(c);
            continue;
        }
        if !run.is_empty() {
            out.push_str(if run.chars().count() >= min_run {
                with
            } else {
                &run
            });
            run.clear();
        }
        out.push(c);
    }
    if !run.is_empty() {
        out.push_str(if run.chars().count() >= min_run {
            with
        } else {
            &run
        });
    }
    out
}

/// Sanitise a single file *base name* (no directory, no extension handling). The result is never empty and is safe on
/// Windows, macOS and Linux.
pub fn sanitize_filename(name: &str, fallback: &str, max_length: usize) -> String {
    let nfc: String = name.nfc().collect();
    let dashed = colon_to_dash(&nfc);
    let legal: String = dashed
        .chars()
        .map(|c| if is_illegal(c) { '_' } else { c })
        .collect();
    let spaced = collapse(&legal, is_js_space, " ", 1);
    let mut out = collapse(js::trim(&spaced), |c| c == '_', "_", 2);
    out = out
        .trim_start_matches(|c: char| c == '.' || c == '_' || is_js_space(c))
        .to_string();
    out = out
        .trim_end_matches(|c: char| c == '.' || is_js_space(c))
        .to_string();
    if js::len_utf16(&out) > max_length {
        out = js::slice_utf16(&out, max_length)
            .trim_end_matches(|c: char| c == '.' || is_js_space(c))
            .to_string();
    }
    if out.is_empty() {
        return fallback.to_string();
    }
    if is_reserved_windows(out.split('.').next().unwrap_or("")) {
        out = format!("_{out}");
    }
    out
}

/// Sanitise a relative sub-folder path. Drops `..`, absolute prefixes and empty segments. Max 4 levels.
pub fn sanitize_subfolder(path: &str) -> String {
    path.split(['\\', '/'])
        .map(js::trim)
        .filter(|seg| !seg.is_empty() && *seg != "." && *seg != "..")
        .map(|seg| sanitize_filename(seg, "", 60))
        .filter(|seg| !seg.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("/")
}

/// ASCII-only form of a file name, for when Chrome rejects the original. Accents are folded; anything else becomes "_".
pub fn ascii_file_name(name: &str) -> String {
    let folded: String = name
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .map(|c| if (' '..='~').contains(&c) { c } else { '_' })
        .collect();
    collapse(&folded, |c| c == '_', "_", 2)
}

/// Ensure the final name ends with the given extension (case-insensitive), without doubling it.
pub fn with_extension(base: &str, ext: &str) -> String {
    let e = ext.strip_prefix('.').unwrap_or(ext).to_lowercase();
    if base.to_lowercase().ends_with(&format!(".{e}")) {
        base.to_string()
    } else {
        format!("{base}.{e}")
    }
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct NameTokens {
    pub title: String,
    pub host: String,
    pub resolution: String,
    pub date: String,
    pub format: String,
    pub id: String,
}

/// Render a naming template. Unknown tokens are removed; empty `[]`/`()` leftovers are cleaned up.
pub fn render_name_template(template: &str, t: &NameTokens) -> String {
    let mut rendered = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        rendered.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let key_len = after
            .bytes()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
            .count();
        if key_len > 0 && after.as_bytes().get(key_len) == Some(&b'}') {
            rendered.push_str(match &after[..key_len] {
                "title" => &t.title,
                "host" => &t.host,
                "resolution" => &t.resolution,
                "date" => &t.date,
                "format" => &t.format,
                "id" => &t.id,
                _ => "",
            });
            rest = &after[key_len + 1..];
        } else {
            rendered.push('{');
            rest = after;
        }
    }
    rendered.push_str(rest);
    // `.replace(/\[\s*\]|\(\s*\)/g, '')`
    let mut cleaned = String::with_capacity(rendered.len());
    let mut i = 0;
    while i < rendered.len() {
        let rest = &rendered[i..];
        let c = rest.chars().next().unwrap_or(' ');
        if c == '[' || c == '(' {
            let close = if c == '[' { ']' } else { ')' };
            let inner: usize = rest[1..]
                .chars()
                .take_while(|x| is_js_space(*x))
                .map(char::len_utf8)
                .sum();
            if rest[1 + inner..].starts_with(close) {
                i += 1 + inner + 1;
                continue;
            }
        }
        cleaned.push(c);
        i += c.len_utf8();
    }
    let cleaned = collapse(&cleaned, is_js_space, " ", 2);
    sanitize_filename(
        js::trim(&cleaned),
        &sanitize_filename(&t.title, "video", 150),
        150,
    )
}
