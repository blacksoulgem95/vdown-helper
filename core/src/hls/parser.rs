//! HLS master / media playlist parser. Never panics; failures are typed errors.

use std::collections::HashMap;

use super::attributes::{parse_attributes, parse_number, parse_resolution};
use super::types::*;
use crate::js;
use crate::url::{MAX_URL_LENGTH, is_safe_fetch_url, parse_url};

/// The most segments a playlist may list (the segment engine has the same limit).
pub const MAX_SEGMENTS: usize = 20_000;

const MEDIA_TAGS: [&str; 8] = [
    "#EXT-X-TARGETDURATION",
    "#EXT-X-MEDIA-SEQUENCE",
    "#EXT-X-ENDLIST",
    "#EXT-X-PLAYLIST-TYPE",
    "#EXT-X-BYTERANGE",
    "#EXT-X-MAP",
    "#EXT-X-KEY",
    "#EXT-X-DISCONTINUITY",
];
const MASTER_TAGS: [&str; 3] = [
    "#EXT-X-STREAM-INF",
    "#EXT-X-I-FRAME-STREAM-INF",
    "#EXT-X-SESSION-KEY",
];

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

/// Lines split on `\r\n`, `\n` or `\r`, each trimmed.
fn clean_lines(text: &str) -> Vec<&str> {
    strip_bom(text)
        .split("\r\n")
        .flat_map(|l| l.split(['\n', '\r']))
        .map(js::trim)
        .collect()
}

fn has_tag(lines: &[&str], tags: &[&str]) -> bool {
    lines.iter().any(|l| {
        tags.iter()
            .any(|t| *l == *t || l.strip_prefix(t).is_some_and(|r| r.starts_with(':')))
    })
}

fn starts_with_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `/^<MPD[\s>]/i` against the start of `s` (`\s` as in JavaScript).
fn mpd_tag_at(s: &str) -> bool {
    starts_with_ci(s, "<MPD")
        && s[4..]
            .chars()
            .next()
            .is_some_and(|c| c == '>' || js::is_js_space(c))
}

/// Decide what kind of playlist-like document `text` is: an HLS master or media playlist, an ordinary M3U list (audio
/// or IPTV list with no HLS semantics), an MPEG-DASH MPD, or anything else.
pub fn classify_playlist(text: &str) -> PlaylistClass {
    let head = js::trim_start(strip_bom(text));
    if starts_with_ci(head, "<?xml") || mpd_tag_at(head) {
        // The first 4096 UTF-16 code units, like `head.slice(0, 4096)`.
        let mut units = 0;
        let end = head
            .char_indices()
            .find(|(_, c)| {
                units += c.len_utf16();
                units > 4096
            })
            .map_or(head.len(), |(i, _)| i);
        let window = &head[..end];
        if window.char_indices().any(|(i, _)| mpd_tag_at(&window[i..])) {
            return PlaylistClass::Dash;
        }
    }
    if !head.starts_with("#EXTM3U") {
        return PlaylistClass::Unsupported;
    }
    let lines = clean_lines(head);
    if has_tag(&lines, &MASTER_TAGS) || lines.iter().any(|l| l.starts_with("#EXT-X-MEDIA:")) {
        return PlaylistClass::HlsMaster;
    }
    if has_tag(&lines, &MEDIA_TAGS) {
        return PlaylistClass::HlsMedia;
    }
    PlaylistClass::M3uPlain
}

fn resolve_uri(uri: &str, base: &str) -> Option<String> {
    // Each relative line is resolved against the playlist's own address: a long base would multiply into every segment.
    if uri.encode_utf16().count() > MAX_URL_LENGTH || base.encode_utf16().count() > MAX_URL_LENGTH {
        return None;
    }
    let href = parse_url(uri, Some(base))?.to_string();
    is_safe_fetch_url(&href).then_some(href)
}

struct RawByteRange {
    length: f64,
    /// Absent when the range continues from the previous range of the same resource.
    offset: Option<f64>,
}

fn parse_byte_range(value: &str) -> Option<RawByteRange> {
    let v = js::trim(value);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (len, off) = match v.split_once('@') {
        Some((l, o)) => (l, Some(o)),
        None => (v, None),
    };
    if !digits(len) || off.is_some_and(|o| !digits(o)) {
        return None;
    }
    Some(RawByteRange {
        length: js::number(len),
        offset: off.map(js::number),
    })
}

fn attr<'a>(a: &'a HashMap<String, String>, k: &str) -> Option<&'a str> {
    a.get(k).map(String::as_str)
}

/// A non-empty attribute value (TypeScript's `if (a['X'])`).
fn present<'a>(a: &'a HashMap<String, String>, k: &str) -> Option<&'a str> {
    attr(a, k).filter(|v| !v.is_empty())
}

fn parse_key(attrs: &HashMap<String, String>, base: &str) -> Option<HlsKey> {
    let method = match attr(attrs, "METHOD").unwrap_or("").to_uppercase().as_str() {
        "NONE" => return None,
        "AES-128" => KeyMethod::Aes128,
        "SAMPLE-AES" => KeyMethod::SampleAes,
        "SAMPLE-AES-CTR" => KeyMethod::SampleAesCtr,
        _ => KeyMethod::Unknown,
    };
    let key_format = attr(attrs, "KEYFORMAT")
        .unwrap_or("identity")
        .to_lowercase();
    let uri = present(attrs, "URI").and_then(|u| resolve_uri(u, base));
    // Only plain AES-128 with the identity key format and a fetchable http(s) key can be decrypted by a normal client.
    let protected_by_drm = method != KeyMethod::Aes128
        || !(key_format == "identity" || key_format.is_empty())
        || uri.is_none();
    Some(HlsKey {
        method,
        uri,
        iv: present(attrs, "IV").map(str::to_string),
        key_format,
        protected_by_drm,
    })
}

fn parse_master(lines: &[&str], url: &str) -> HlsParseResult {
    let mut variants: Vec<HlsVariant> = Vec::new();
    let mut renditions: Vec<HlsRendition> = Vec::new();
    let mut session_keys = Vec::new();
    let mut version = None;
    let mut i_frame_streams = 0.0;
    let mut pending: Option<HashMap<String, String>> = None;
    let mut pending_line = 0;

    for (idx, &line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        if let Some(v) = line.strip_prefix("#EXT-X-VERSION:") {
            version = parse_number(Some(v));
        } else if let Some(v) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = Some(parse_attributes(v));
            pending_line = idx + 1;
        } else if line.starts_with("#EXT-X-I-FRAME-STREAM-INF:") {
            i_frame_streams += 1.0;
        } else if let Some(v) = line.strip_prefix("#EXT-X-MEDIA:") {
            let a = parse_attributes(v);
            let kind = match attr(&a, "TYPE").unwrap_or("").to_uppercase().as_str() {
                "AUDIO" => RenditionType::Audio,
                "VIDEO" => RenditionType::Video,
                "SUBTITLES" => RenditionType::Subtitles,
                "CLOSED-CAPTIONS" => RenditionType::ClosedCaptions,
                _ => continue,
            };
            let raw_uri = present(&a, "URI");
            let uri = raw_uri.and_then(|u| resolve_uri(u, url));
            if raw_uri.is_some() && uri.is_none() {
                return HlsParseResult::err(
                    HlsErrorCode::UnsafeUrl,
                    "Rendition URI uses a disallowed scheme",
                    Some(idx + 1),
                );
            }
            renditions.push(HlsRendition {
                kind,
                group_id: attr(&a, "GROUP-ID").unwrap_or("").to_string(),
                name: attr(&a, "NAME")
                    .or(attr(&a, "LANGUAGE"))
                    .unwrap_or(kind.as_str())
                    .to_string(),
                language: present(&a, "LANGUAGE").map(str::to_string),
                uri,
                is_default: attr(&a, "DEFAULT").unwrap_or("").to_uppercase() == "YES",
                auto_select: attr(&a, "AUTOSELECT").unwrap_or("").to_uppercase() == "YES",
                channels: present(&a, "CHANNELS").map(str::to_string),
                codecs: None,
            });
        } else if let Some(v) = line.strip_prefix("#EXT-X-SESSION-KEY:") {
            if let Some(k) = parse_key(&parse_attributes(v), url) {
                session_keys.push(k);
            }
        } else if !line.starts_with('#') {
            let Some(p) = pending.take() else { continue }; // stray URI without STREAM-INF: ignore
            let bandwidth = match parse_number(attr(&p, "BANDWIDTH")) {
                Some(b) if b > 0.0 => b,
                _ => {
                    return HlsParseResult::err(
                        HlsErrorCode::Malformed,
                        "EXT-X-STREAM-INF is missing a valid BANDWIDTH",
                        Some(pending_line),
                    );
                }
            };
            let Some(uri) = resolve_uri(line, url) else {
                return HlsParseResult::err(
                    HlsErrorCode::UnsafeUrl,
                    "Variant URI is invalid or uses a disallowed scheme",
                    Some(idx + 1),
                );
            };
            let res = parse_resolution(attr(&p, "RESOLUTION"));
            variants.push(HlsVariant {
                uri,
                bandwidth,
                average_bandwidth: parse_number(attr(&p, "AVERAGE-BANDWIDTH")),
                width: res.map(|r| r.0),
                height: res.map(|r| r.1),
                frame_rate: parse_number(attr(&p, "FRAME-RATE")),
                codecs: present(&p, "CODECS").map(str::to_string),
                video_range: present(&p, "VIDEO-RANGE").map(str::to_string),
                audio_group: present(&p, "AUDIO").map(str::to_string),
                subtitle_group: present(&p, "SUBTITLES").map(str::to_string),
            });
        }
    }

    if variants.is_empty() && renditions.iter().all(|r| r.uri.is_none()) {
        return HlsParseResult::err(
            HlsErrorCode::Malformed,
            "Master playlist declares no playable variants",
            None,
        );
    }
    // Highest resolution first, then bandwidth (a stable sort, like Array.prototype.sort).
    variants.sort_by(|a, b| {
        let by_height = b.height.unwrap_or(0.0) - a.height.unwrap_or(0.0);
        let d = if by_height != 0.0 {
            by_height
        } else {
            b.bandwidth - a.bandwidth
        };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    HlsParseResult::ok(HlsPlaylist::Master(HlsMasterPlaylist {
        url: url.to_string(),
        version,
        variants,
        renditions,
        i_frame_streams,
        session_keys,
    }))
}

fn parse_media(lines: &[&str], url: &str) -> HlsParseResult {
    let mut segments: Vec<HlsSegment> = Vec::new();
    let mut version = None;
    let mut target_duration = None;
    let mut media_sequence = 0.0;
    let mut playlist_type = None;
    let mut end_list = false;
    let mut current_key: Option<HlsKey> = None;
    let mut current_map: Option<HlsMap> = None;
    let mut pending_duration: Option<f64> = None;
    let mut pending_title: Option<String> = None;
    let mut pending_range: Option<RawByteRange> = None;
    let mut discontinuity = false;
    let mut last_range_end: Option<f64> = None;
    let mut last_range_uri: Option<String> = None;
    let mut encryption: Vec<KeyMethod> = Vec::new();
    let mut has_drm = false;
    let mut fragmented = false;

    for (idx, &line) in lines.iter().enumerate() {
        if line.is_empty() {
            continue;
        }
        if let Some(v) = line.strip_prefix("#EXT-X-VERSION:") {
            version = parse_number(Some(v));
        } else if let Some(v) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_duration = parse_number(Some(v));
        } else if let Some(v) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = parse_number(Some(v)).unwrap_or(0.0);
        } else if let Some(v) = line.strip_prefix("#EXT-X-PLAYLIST-TYPE:") {
            match js::trim(v).to_uppercase().as_str() {
                "VOD" => playlist_type = Some(PlaylistType::Vod),
                "EVENT" => playlist_type = Some(PlaylistType::Event),
                _ => {}
            }
        } else if line == "#EXT-X-ENDLIST" {
            end_list = true;
        } else if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = true;
        } else if let Some(v) = line.strip_prefix("#EXT-X-KEY:") {
            current_key = parse_key(&parse_attributes(v), url);
            if let Some(k) = &current_key {
                if !encryption.contains(&k.method) {
                    encryption.push(k.method);
                }
                has_drm |= k.protected_by_drm;
            }
        } else if let Some(v) = line.strip_prefix("#EXT-X-MAP:") {
            let a = parse_attributes(v);
            let Some(uri_raw) = present(&a, "URI") else {
                return HlsParseResult::err(
                    HlsErrorCode::Malformed,
                    "EXT-X-MAP without URI",
                    Some(idx + 1),
                );
            };
            let Some(uri) = resolve_uri(uri_raw, url) else {
                return HlsParseResult::err(
                    HlsErrorCode::UnsafeUrl,
                    "Init-section URI is invalid or uses a disallowed scheme",
                    Some(idx + 1),
                );
            };
            let byte_range = present(&a, "BYTERANGE")
                .and_then(parse_byte_range)
                .map(|br| HlsByteRange {
                    length: br.length,
                    offset: br.offset.unwrap_or(0.0),
                });
            current_map = Some(HlsMap {
                uri,
                byte_range,
                key: current_key.clone(),
            });
            fragmented = true;
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            let (dur, title) = match rest.find(',') {
                Some(c) => (&rest[..c], js::trim(&rest[c + 1..])),
                None => (rest, ""),
            };
            match parse_number(Some(js::trim(dur))) {
                Some(d) if d >= 0.0 => pending_duration = Some(d),
                _ => {
                    return HlsParseResult::err(
                        HlsErrorCode::Malformed,
                        "EXTINF has an invalid duration",
                        Some(idx + 1),
                    );
                }
            }
            pending_title = (!title.is_empty()).then(|| title.to_string());
        } else if let Some(v) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            pending_range = parse_byte_range(v);
            if pending_range.is_none() {
                return HlsParseResult::err(
                    HlsErrorCode::Malformed,
                    "EXT-X-BYTERANGE is invalid",
                    Some(idx + 1),
                );
            }
        } else if !line.starts_with('#') {
            let Some(duration) = pending_duration else {
                continue;
            }; // URI without EXTINF: not a segment
            let Some(uri) = resolve_uri(line, url) else {
                return HlsParseResult::err(
                    HlsErrorCode::UnsafeUrl,
                    "Segment URI is invalid or uses a disallowed scheme",
                    Some(idx + 1),
                );
            };
            let byte_range = pending_range.take().map(|r| {
                // Without an explicit offset the range continues from the previous range of the same resource.
                let offset = r.offset.unwrap_or_else(|| {
                    if last_range_uri.as_deref() == Some(uri.as_str()) {
                        last_range_end.unwrap_or(0.0)
                    } else {
                        0.0
                    }
                });
                last_range_end = Some(offset + r.length);
                last_range_uri = Some(uri.clone());
                HlsByteRange {
                    length: r.length,
                    offset,
                }
            });
            if segments.len() >= MAX_SEGMENTS {
                return HlsParseResult::err(
                    HlsErrorCode::Malformed,
                    "The playlist lists too many segments",
                    None,
                );
            }
            segments.push(HlsSegment {
                sequence: media_sequence + segments.len() as f64,
                uri,
                duration,
                title: pending_title.take(),
                byte_range,
                discontinuity,
                key: current_key.clone(),
                map: current_map.clone(),
            });
            pending_duration = None;
            discontinuity = false;
        }
    }

    if segments.is_empty() {
        return HlsParseResult::err(
            HlsErrorCode::Malformed,
            "Media playlist contains no segments",
            None,
        );
    }
    HlsParseResult::ok(HlsPlaylist::Media(HlsMediaPlaylist {
        url: url.to_string(),
        version,
        target_duration,
        media_sequence,
        playlist_type,
        end_list,
        total_duration: segments.iter().map(|s| s.duration).sum(),
        segments,
        encryption,
        has_drm,
        fragmented,
    }))
}

/// Parse an HLS playlist.
pub fn parse_hls(text: &str, url: &str) -> HlsParseResult {
    if js::trim(text).is_empty() {
        return HlsParseResult::err(HlsErrorCode::Empty, "The playlist is empty", None);
    }
    match classify_playlist(text) {
        PlaylistClass::Dash => HlsParseResult::err(
            HlsErrorCode::Dash,
            "This is an MPEG-DASH manifest, which is not supported",
            None,
        ),
        PlaylistClass::Unsupported => HlsParseResult::err(
            HlsErrorCode::NotM3u,
            "The document is not an M3U playlist",
            None,
        ),
        PlaylistClass::M3uPlain => HlsParseResult::err(
            HlsErrorCode::NotHls,
            "This is an ordinary M3U playlist, not an HLS manifest",
            None,
        ),
        PlaylistClass::HlsMaster => parse_master(&clean_lines(text), url),
        PlaylistClass::HlsMedia => parse_media(&clean_lines(text), url),
    }
}
