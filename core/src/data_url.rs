//! `data:` URLs from `src/lib/dataUrl.ts`: described without decoding, and replaced everywhere by a harmless label.
//!
//! The page scripts keep their own TypeScript copy (they never load the core); the golden fixtures hold both to the
//! same answers.

use serde::Serialize;

use crate::js::hex8;

/// Largest `data:` URL payload the extension will move (decoded).
pub const MAX_HELD_BYTES: f64 = 32.0 * 1024.0 * 1024.0;
/// Largest `blob:` the extension will move out of a page (it is streamed to disk, not held in memory).
pub const HELD_BLOB_LIMIT: f64 = 4.0 * 1024.0 * 1024.0 * 1024.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DataUrlInfo {
    /// Lower-case media type, e.g. "video/mp4".
    pub mime: String,
    pub base64: bool,
    /// Decoded size in bytes (exact for base64 without whitespace, close otherwise).
    pub bytes: f64,
}

fn mime_char(b: u8) -> bool {
    b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$&^_.+-".contains(&b)
}

/// `/^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/`
fn valid_mime(m: &str) -> bool {
    let part = |p: &str, max: usize| {
        let b = p.as_bytes();
        !b.is_empty()
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.len() <= max + 1
            && b.iter().all(|c| mime_char(*c))
    };
    m.split_once('/')
        .is_some_and(|(t, s)| part(t, 60) && part(s, 100))
}

/// Describe a `data:` URL without decoding it; `None` for anything that is not a well-formed one.
pub fn inspect_data_url(url: &str) -> Option<DataUrlInfo> {
    if !url
        .get(..5)
        .is_some_and(|p| p.eq_ignore_ascii_case("data:"))
    {
        return None;
    }
    let comma = url.find(',')?;
    // JavaScript measures in UTF-16 code units.
    let comma16 = url[..comma].encode_utf16().count();
    if !(5..=300).contains(&comma16) {
        return None;
    }
    let mut header = url[5..comma].split(';');
    let mime = crate::js::trim(header.next().unwrap_or("")).to_lowercase();
    let mime = if mime.is_empty() {
        "text/plain".to_string()
    } else {
        mime
    };
    if !valid_mime(&mime) {
        return None;
    }
    let base64 = header.any(|p| crate::js::trim(p).to_lowercase() == "base64");
    let payload = &url[comma + 1..];
    let n = payload.encode_utf16().count() as f64;
    let bytes = if base64 {
        let pad = if url.ends_with("==") {
            2.0
        } else if url.ends_with('=') {
            1.0
        } else {
            0.0
        };
        ((n * 3.0 / 4.0).floor() - pad).max(0.0)
    } else {
        n - 2.0 * percent_escapes(payload) as f64
    };
    Some(DataUrlInfo {
        mime,
        base64,
        bytes,
    })
}

/// Non-overlapping `%XX` escapes, like `/%[0-9a-f]{2}/gi`.
fn percent_escapes(s: &str) -> usize {
    let b = s.as_bytes();
    let (mut i, mut n) = (0, 0);
    while i < b.len() {
        if b[i] == b'%'
            && b.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
            && b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
        {
            n += 1;
            i += 3;
        } else {
            i += 1;
        }
    }
    n
}

/// Stable short handle for a `data:` URL (FNV-1a over its head, tail and length): not a security hash.
pub fn data_handle(url: &str) -> String {
    let units: Vec<u16> = url.encode_utf16().collect();
    let len = units.len();
    let head = &units[..len.min(4096)];
    let tail = &units[len.saturating_sub(4096)..];
    let mut sample: Vec<u16> = len.to_string().encode_utf16().collect();
    sample.push(u16::from(b'|'));
    sample.extend_from_slice(head);
    sample.push(u16::from(b'|'));
    sample.extend_from_slice(tail);
    let h = sample.iter().fold(0x811c_9dc5_u32, |h, c| {
        (h ^ u32::from(*c)).wrapping_mul(0x0100_0193)
    });
    hex8(h)
}

/// The harmless label that stands in for a `data:` URL everywhere a URL is expected (it carries no payload).
pub fn data_label(mime: &str, handle: &str) -> String {
    format!("data:{mime};vdh={handle}")
}

/// Stand-in label for a `blob:` URL (its type is only known once the page has been asked).
pub fn blob_label(handle: &str) -> String {
    data_label("application/x-vdh-blob", handle)
}

/// `/^data:[a-z0-9!#$&^_.+\/-]{3,170};vdh=[a-f0-9]{8}$/`
pub fn is_data_label(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("data:") else {
        return false;
    };
    let Some((mime, handle)) = rest.rsplit_once(";vdh=") else {
        return false;
    };
    (3..=170).contains(&mime.len())
        && mime.bytes().all(|b| mime_char(b) || b == b'/')
        && handle.len() == 8
        && handle
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The most a held source of this kind may be.
pub fn held_limit(kind: &str) -> f64 {
    if kind == "data" {
        MAX_HELD_BYTES
    } else {
        HELD_BLOB_LIMIT
    }
}

pub fn exceeds_held_limit(bytes: f64, kind: &str) -> bool {
    bytes > held_limit(kind)
}
