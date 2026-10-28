//! MPEG-DASH (ISO/IEC 23009-1) manifest parser and segment expansion (`src/lib/dash/parser.ts`).

use std::collections::HashMap;

use super::types::*;
use crate::hls::{HlsByteRange, HlsMap, HlsSegment, OkTrue};
use crate::js;
use crate::url::{MAX_URL_LENGTH, is_safe_fetch_url, parse_url};
use crate::xml::{XmlLimits, XmlNode, local_name, parse_xml};

pub const MAX_SEGMENTS: usize = 50_000;
/// Total characters of segment addresses one representation may hold.
pub const MAX_URI_CHARS: usize = 8_000_000;

/// ISO 8601 duration ("PT1H2M3.5S") in seconds. Years and months are approximations, as the DASH spec allows.
pub fn parse_iso_duration(value: Option<&str>) -> Option<f64> {
    let v = js::trim(value.filter(|v| !v.is_empty())?);
    let mut rest = v.strip_prefix('P')?;
    // [Y, M, D, H, M, S]
    let mut parts: [Option<f64>; 6] = [None; 6];
    let mut slot = 0; // next allowed component
    let mut in_time = false;
    while !rest.is_empty() {
        if !in_time && rest.starts_with('T') {
            in_time = true;
            slot = 3;
            rest = &rest[1..];
            continue;
        }
        let int = rest.bytes().take_while(u8::is_ascii_digit).count();
        if int == 0 {
            return None;
        }
        let mut len = int;
        if rest.as_bytes().get(int) == Some(&b'.') {
            let frac = rest[int + 1..]
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
            if frac == 0 {
                return None;
            }
            len = int + 1 + frac;
        }
        let n = js::number(&rest[..len]);
        let designators: &[(u8, usize)] = if in_time {
            &[(b'H', 3), (b'M', 4), (b'S', 5)]
        } else {
            &[(b'Y', 0), (b'M', 1), (b'D', 2)]
        };
        let d = *rest.as_bytes().get(len)?;
        let &(_, idx) = designators.iter().find(|(c, i)| *c == d && *i >= slot)?;
        parts[idx] = Some(n);
        slot = idx + 1;
        rest = &rest[len + 1..];
    }
    if parts.iter().all(Option::is_none) {
        return None; // at least one component is required
    }
    let n = |i: usize| parts[i].unwrap_or(0.0);
    Some(
        n(0) * 31_536_000.0
            + n(1) * 2_592_000.0
            + n(2) * 86_400.0
            + n(3) * 3600.0
            + n(4) * 60.0
            + n(5),
    )
}

fn num(v: Option<&str>) -> Option<f64> {
    js::finite_number(v)
}

fn frame_rate(v: Option<&str>) -> Option<f64> {
    let v = js::trim(v.filter(|v| !v.is_empty())?);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let (a, b) = v.split_once('/').unwrap_or((v, "1"));
    if !digits(a) || !digits(b) {
        return None;
    }
    let r = js::number(a) / js::number(b);
    (r.is_finite() && r > 0.0).then(|| (r * 1000.0).round() / 1000.0)
}

fn system_of_uuid(uuid: &str) -> DashProtectionSystem {
    match uuid {
        "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" => DashProtectionSystem::Widevine,
        "9a04f079-9840-4286-ab92-e65be0885f95" => DashProtectionSystem::Playready,
        "94ce86fb-07ff-4f43-adb8-93d2fa968ca2" => DashProtectionSystem::Fairplay,
        "5e629af5-38da-4063-8977-97ffbd9902d4" => DashProtectionSystem::Marlin,
        "e2719d58-a985-b3c9-781a-b030af78d30e" => DashProtectionSystem::Clearkey,
        "1077efec-c0b2-4d02-ace3-3c1e52e2fb4b" => DashProtectionSystem::Clearkey, // W3C Common PSSH box for ClearKey
        _ => DashProtectionSystem::Other,
    }
}

fn protection_of(node: &XmlNode) -> DashProtection {
    let scheme = js::trim(node.attrs.get("schemeIdUri").unwrap_or(""));
    let lower = scheme.to_lowercase();
    let uuid = lower.strip_prefix("urn:uuid:").filter(|u| {
        u.len() == 36
            && u.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
    });
    let system = if let Some(u) = uuid {
        system_of_uuid(u)
    } else if lower == "urn:mpeg:dash:mp4protection:2011" {
        DashProtectionSystem::Cenc
    } else if lower.contains("clearkey") {
        DashProtectionSystem::Clearkey
    } else {
        DashProtectionSystem::Other
    };
    let laurl = node
        .children
        .iter()
        .find(|c| local_name(&c.name).to_lowercase() == "laurl")
        .map(|c| js::trim(&c.text))
        .filter(|l| !l.is_empty() && is_safe_fetch_url(l));
    let kid = node
        .attrs
        .iter()
        .find(|(k, _)| local_name(k) == "default_KID")
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty());
    DashProtection {
        system,
        scheme_id_uri: js::slice_utf16(scheme, 200).to_string(),
        license_url: laurl.map(str::to_string),
        default_kid: kid.map(|k| js::slice_utf16(k, 64).to_string()),
    }
}

/// Combine the attributes of the same element at several levels; deeper levels win.
fn merge_attrs(nodes: &[Option<&XmlNode>]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for n in nodes.iter().flatten() {
        for (k, v) in n.attrs.iter() {
            out.insert(k.to_string(), v.to_string());
        }
    }
    out
}

fn resolve(r: &str, base: &str) -> Option<String> {
    if js::len_utf16(r) > MAX_URL_LENGTH || js::len_utf16(base) > MAX_URL_LENGTH {
        return None;
    }
    let href = parse_url(js::trim(r), Some(base))?.to_string();
    is_safe_fetch_url(&href).then_some(href)
}

fn starts_with_any(s: &str, prefixes: &[&str]) -> bool {
    prefixes.iter().any(|p| s.starts_with(p))
}

fn content_of(set: &XmlNode, rep: &XmlNode, mime: &str, codecs: Option<&str>) -> DashContent {
    let declared = rep
        .attrs
        .get("contentType")
        .or(set.attrs.get("contentType"))
        .unwrap_or("")
        .to_lowercase();
    match declared.as_str() {
        "video" => return DashContent::Video,
        "audio" => return DashContent::Audio,
        "text" => return DashContent::Text,
        "image" => return DashContent::Other,
        _ => {}
    }
    let m = mime.to_lowercase();
    if m.starts_with("video/") {
        return DashContent::Video;
    }
    if m.starts_with("audio/") {
        return DashContent::Audio;
    }
    if m.starts_with("text/") || m.contains("ttml") || m.contains("vtt") {
        return DashContent::Text;
    }
    let c = codecs.unwrap_or("").to_lowercase();
    if starts_with_any(&c, &["stpp", "wvtt"]) {
        return DashContent::Text;
    }
    if starts_with_any(
        &c,
        &[
            "avc", "hvc", "hev", "av01", "vp8", "vp9", "vp08", "vp09", "dvh",
        ],
    ) {
        return DashContent::Video;
    }
    if starts_with_any(&c, &["mp4a", "ac-3", "ec-3", "opus", "vorbis", "flac"]) {
        return DashContent::Audio;
    }
    DashContent::Other
}

fn byte_range(range: &str) -> Option<DashByteRange> {
    let (a, b) = js::trim(range).split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let (a, b) = (js::number(a), js::number(b));
    Some(DashByteRange {
        offset: a,
        length: b - a + 1.0,
    })
}

fn file_ref(node: Option<&XmlNode>, base: &str) -> Option<DashSegmentRef> {
    let node = node?;
    let src = node.attrs.get("sourceURL").or(node.attrs.get("media"))?;
    let range = node.attrs.get("range").or(node.attrs.get("mediaRange"));
    if src.is_empty() {
        return None;
    }
    let url = resolve(src, base)?;
    Some(DashSegmentRef {
        url,
        range: range.filter(|r| !r.is_empty()).and_then(byte_range),
    })
}

fn addressing_of(
    levels: [&XmlNode; 3],
    base_url: &str,
    has_explicit_base: bool,
) -> Option<DashAddressing> {
    let templates: Vec<Option<&XmlNode>> = levels
        .iter()
        .map(|l| l.first_child("SegmentTemplate"))
        .collect();
    if templates.iter().any(Option::is_some) {
        let a = merge_attrs(&templates);
        let timeline_node = templates
            .iter()
            .rev()
            .find_map(|t| t.and_then(|t| t.first_child("SegmentTimeline")));
        let media = a
            .get("media")
            .filter(|m| !m.is_empty() && js::len_utf16(m) <= MAX_URL_LENGTH)?;
        let get = |k: &str| a.get(k).map(String::as_str);
        let timeline = timeline_node.map(|tl| {
            tl.children_named("S")
                .filter_map(|s| {
                    let d = num(s.attrs.get("d")).filter(|d| *d > 0.0)?;
                    Some(TimelineEntry {
                        t: num(s.attrs.get("t")),
                        d,
                        r: num(s.attrs.get("r")).unwrap_or(0.0),
                    })
                })
                .collect::<Vec<_>>()
        });
        let duration = num(get("duration")).filter(|d| *d > 0.0);
        if timeline.is_none() && duration.is_none() {
            return None;
        }
        return Some(DashAddressing::Template {
            initialization: get("initialization")
                .filter(|i| !i.is_empty() && js::len_utf16(i) <= MAX_URL_LENGTH)
                .map(str::to_string),
            media: media.clone(),
            start_number: num(get("startNumber")).unwrap_or(1.0),
            timescale: num(get("timescale")).unwrap_or(1.0).max(1.0),
            duration,
            timeline,
            presentation_time_offset: num(get("presentationTimeOffset")).unwrap_or(0.0),
        });
    }
    let lists: Vec<Option<&XmlNode>> = levels
        .iter()
        .map(|l| l.first_child("SegmentList"))
        .collect();
    if lists.iter().any(Option::is_some) {
        let a = merge_attrs(&lists);
        let with_urls = lists
            .iter()
            .rev()
            .flatten()
            .find(|l| l.children_named("SegmentURL").next().is_some())?;
        let timescale = num(a.get("timescale").map(String::as_str))
            .unwrap_or(1.0)
            .max(1.0);
        let dur = num(a.get("duration").map(String::as_str)).filter(|d| *d != 0.0);
        let init = lists
            .iter()
            .rev()
            .find_map(|l| l.and_then(|l| l.first_child("Initialization")));
        let segments: Vec<DashListSegment> = with_urls
            .children_named("SegmentURL")
            .filter_map(|s| file_ref(Some(s), base_url))
            .map(|r| DashListSegment {
                url: r.url,
                range: r.range,
                duration_sec: dur.map(|d| d / timescale),
            })
            .collect();
        if segments.is_empty() {
            return None;
        }
        return Some(DashAddressing::List {
            initialization: file_ref(init, base_url),
            segments,
            timescale,
        });
    }
    // SegmentBase / plain BaseURL: the representation is one whole (fragmented) file.
    has_explicit_base.then(|| DashAddressing::Single {
        url: base_url.to_string(),
    })
}

/// A non-empty, trimmed `BaseURL` child, resolved against `base`: `Err` when it is not an allowed address.
fn base_of(node: &XmlNode, base: &str) -> Result<Option<String>, DashParseResult> {
    let Some(b) = node
        .first_child("BaseURL")
        .map(|b| js::trim(&b.text))
        .filter(|b| !b.is_empty())
    else {
        return Ok(None);
    };
    resolve(b, base).map(Some).ok_or_else(|| {
        DashParseResult::err(DashErrorCode::UnsafeUrl, "BaseURL uses a disallowed scheme")
    })
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

pub fn parse_dash(text: &str, url: &str) -> DashParseResult {
    match parse_dash_inner(text, url) {
        Ok(manifest) => DashParseResult::Ok {
            ok: OkTrue,
            manifest,
        },
        Err(e) => e,
    }
}

fn parse_dash_inner(text: &str, url: &str) -> Result<DashManifest, DashParseResult> {
    if js::trim(text).is_empty() {
        return Err(DashParseResult::err(
            DashErrorCode::Empty,
            "The manifest is empty",
        ));
    }
    let root = parse_xml(text, XmlLimits::default()).ok_or_else(|| {
        DashParseResult::err(DashErrorCode::Malformed, "The manifest is not valid XML")
    })?;
    if local_name(&root.name) != "MPD" {
        return Err(DashParseResult::err(
            DashErrorCode::NotDash,
            "The document is not an MPEG-DASH manifest",
        ));
    }
    let kind = if root.attrs.get("type") == Some("dynamic") {
        DashType::Dynamic
    } else {
        DashType::Static
    };
    let (manifest_base, explicit_base) = match base_of(&root, url)? {
        Some(b) => (b, true),
        None => (url.to_string(), false),
    };

    let mut periods = Vec::new();
    let mut cursor = 0.0;
    for period in root.children_named("Period") {
        let duration = parse_iso_duration(period.attrs.get("duration"));
        let start = parse_iso_duration(period.attrs.get("start")).unwrap_or(cursor);
        let (period_base, period_explicit) = match base_of(period, &manifest_base)? {
            Some(b) => (b, true),
            None => (manifest_base.clone(), explicit_base),
        };
        let mut representations = Vec::new();
        for set in period.children_named("AdaptationSet") {
            let (set_base, set_explicit) = match base_of(set, &period_base)? {
                Some(b) => (b, true),
                None => (period_base.clone(), period_explicit),
            };
            let set_protections: Vec<DashProtection> = set
                .children_named("ContentProtection")
                .map(protection_of)
                .collect();
            for rep in set.children_named("Representation") {
                let (rep_base, rep_explicit) = match base_of(rep, &set_base)? {
                    Some(b) => (b, true),
                    None => (set_base.clone(), set_explicit),
                };
                let pick = |k: &str| rep.attrs.get(k).or(set.attrs.get(k));
                let mime = pick("mimeType").unwrap_or("");
                let codecs = pick("codecs");
                let content = content_of(set, rep, mime, codecs);
                let addressing = addressing_of([period, set, rep], &rep_base, rep_explicit);
                let (Some(id), Some(addressing)) = (non_empty(rep.attrs.get("id")), addressing)
                else {
                    continue;
                };
                if content == DashContent::Other {
                    continue;
                }
                let label = set
                    .first_child("Label")
                    .map(|l| js::trim(&l.text))
                    .filter(|l| !l.is_empty())
                    .or_else(|| rep.first_child("Label").map(|l| js::trim(&l.text)))
                    .filter(|l| !l.is_empty());
                let mut protections = set_protections.clone();
                protections.extend(rep.children_named("ContentProtection").map(protection_of));
                representations.push(DashRepresentation {
                    id: js::slice_utf16(id, 100).to_string(),
                    content,
                    mime_type: js::slice_utf16(&mime.to_lowercase(), 100).to_string(),
                    codecs: non_empty(codecs).map(|c| js::slice_utf16(c, 200).to_string()),
                    bandwidth: num(rep.attrs.get("bandwidth")).unwrap_or(0.0),
                    width: num(pick("width")).filter(|w| *w != 0.0),
                    height: num(pick("height")).filter(|h| *h != 0.0),
                    frame_rate: frame_rate(pick("frameRate")),
                    lang: non_empty(pick("lang")).map(|l| js::slice_utf16(l, 20).to_string()),
                    label: label.map(|l| js::slice_utf16(l, 100).to_string()),
                    protections,
                    base_url: rep_base,
                    addressing,
                });
            }
        }
        periods.push(DashPeriod {
            id: non_empty(period.attrs.get("id")).map(|i| js::slice_utf16(i, 100).to_string()),
            start_sec: start,
            duration_sec: duration,
            representations,
        });
        cursor = start + duration.unwrap_or(0.0);
    }

    if periods.is_empty() || periods.iter().all(|p| p.representations.is_empty()) {
        return Err(DashParseResult::err(
            DashErrorCode::Malformed,
            "The manifest has no usable representations",
        ));
    }
    let total = parse_iso_duration(root.attrs.get("mediaPresentationDuration"));
    let summed = periods
        .iter()
        .all(|p| p.duration_sec.is_some())
        .then(|| periods.iter().filter_map(|p| p.duration_sec).sum());
    let mut manifest = DashManifest {
        url: url.to_string(),
        kind,
        duration_sec: total.or(summed),
        availability_start_ms: None,
        minimum_update_sec: None,
        time_shift_buffer_sec: None,
        periods,
    };
    if kind == DashType::Dynamic {
        manifest.availability_start_ms =
            js::parse_iso_date_ms(root.attrs.get("availabilityStartTime").unwrap_or(""));
        manifest.minimum_update_sec = parse_iso_duration(root.attrs.get("minimumUpdatePeriod"));
        manifest.time_shift_buffer_sec = parse_iso_duration(root.attrs.get("timeShiftBufferDepth"));
    }
    Ok(manifest)
}

/// The period that holds the main content: the longest one (ads and bumpers are short periods).
pub fn main_period_index(m: &DashManifest) -> usize {
    // A live stream has no durations: what is on now is the last period.
    if m.kind == DashType::Dynamic {
        return m.periods.len().saturating_sub(1);
    }
    let mut best = 0;
    let mut best_dur = -1.0;
    for (i, p) in m.periods.iter().enumerate() {
        let d = p
            .duration_sec
            .unwrap_or_else(|| m.duration_sec.map_or(0.0, |t| t - p.start_sec));
        if d > best_dur {
            best_dur = d;
            best = i;
        }
    }
    best
}

pub fn period_duration(m: &DashManifest, p: &DashPeriod) -> Option<f64> {
    p.duration_sec
        .or_else(|| m.duration_sec.map(|t| (t - p.start_sec).max(0.0)))
}

/// A value for a template variable.
#[derive(Debug, Clone)]
pub enum Var {
    Str(String),
    Num(f64),
}

/// Fill in $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$; "$$" is a literal dollar sign.
pub fn substitute(template: &str, vars: &HashMap<&str, Var>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(d) = rest.find('$') {
        out.push_str(&rest[..d]);
        rest = &rest[d..];
        if rest[1..].starts_with('$') {
            out.push('$');
            rest = &rest[2..];
            continue;
        }
        let name_len = rest[1..]
            .bytes()
            .take_while(u8::is_ascii_alphabetic)
            .count();
        let after = &rest[1 + name_len..];
        let mut width: Option<&str> = None;
        let mut end = None;
        if name_len > 0 {
            if after.starts_with('$') {
                end = Some(1 + name_len + 1);
            } else if let Some(w) = after.strip_prefix("%0") {
                let wl = w.bytes().take_while(u8::is_ascii_digit).count();
                if wl > 0 && w[wl..].starts_with("d$") {
                    width = Some(&w[..wl]);
                    end = Some(1 + name_len + 2 + wl + 2);
                }
            }
        }
        let Some(end) = end else {
            out.push('$');
            rest = &rest[1..];
            continue;
        };
        let whole = &rest[..end];
        let name = &rest[1..1 + name_len];
        match vars.get(name) {
            None => out.push_str(whole),
            Some(v) => {
                let s = match v {
                    Var::Str(s) => s.clone(),
                    Var::Num(n) => js::number_to_string(*n),
                };
                // the printf width is the manifest's to choose: never let it build a huge string
                let w = width.map_or(0, |w| (js::number(w) as usize).min(20));
                let pad = w.saturating_sub(js::len_utf16(&s));
                out.push_str(&"0".repeat(pad));
                out.push_str(&s);
            }
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedRepresentation {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub init: Option<HlsMap>,
    pub segments: Vec<HlsSegment>,
    pub duration_sec: f64,
}

struct Pusher {
    segments: Vec<HlsSegment>,
    uri_chars: usize,
}

impl Pusher {
    fn push(
        &mut self,
        uri: String,
        duration: f64,
        range: Option<HlsByteRange>,
    ) -> Result<(), String> {
        if self.segments.len() >= MAX_SEGMENTS {
            return Err("The manifest lists too many segments".into());
        }
        // many long addresses are as costly as many segments: bound what a manifest can make the app hold
        self.uri_chars += js::len_utf16(&uri);
        if self.uri_chars > MAX_URI_CHARS {
            return Err("The manifest lists too much address data".into());
        }
        let sequence = self.segments.len() as f64;
        self.segments.push(HlsSegment {
            uri,
            duration,
            title: None,
            sequence,
            byte_range: range,
            discontinuity: false,
            key: None,
            map: None,
        });
        Ok(())
    }
}

fn hls_range(r: Option<DashByteRange>) -> Option<HlsByteRange> {
    r.map(|r| HlsByteRange {
        length: r.length,
        offset: r.offset,
    })
}

/// Turn a representation's addressing into a flat, ordered list of absolute segment URLs. `now_ms` is the clock of a
/// dynamic manifest (ms since the epoch). `Err` carries the reason (`DashExpandError` in TypeScript).
pub fn expand_segments(
    m: &DashManifest,
    period: &DashPeriod,
    rep: &DashRepresentation,
    now_ms: f64,
) -> Result<ExpandedRepresentation, String> {
    let mut p = Pusher {
        segments: Vec::new(),
        uri_chars: 0,
    };
    let mut init: Option<HlsMap> = None;
    match &rep.addressing {
        DashAddressing::Single { url } => {
            p.push(url.clone(), period_duration(m, period).unwrap_or(0.0), None)?
        }
        DashAddressing::List {
            initialization,
            segments,
            ..
        } => {
            if let Some(i) = initialization {
                init = Some(HlsMap {
                    uri: i.url.clone(),
                    byte_range: hls_range(i.range),
                    key: None,
                });
            }
            for s in segments {
                p.push(
                    s.url.clone(),
                    s.duration_sec.unwrap_or(0.0),
                    hls_range(s.range),
                )?;
            }
        }
        DashAddressing::Template {
            initialization,
            media,
            start_number,
            timescale,
            duration,
            timeline,
            presentation_time_offset,
        } => {
            let mut vars: HashMap<&str, Var> = HashMap::new();
            vars.insert("RepresentationID", Var::Str(rep.id.clone()));
            vars.insert("Bandwidth", Var::Num(rep.bandwidth));
            if let Some(i) = initialization {
                let u = resolve(&substitute(i, &vars), &rep.base_url)
                    .ok_or("The initialization URL is not allowed")?;
                init = Some(HlsMap {
                    uri: u,
                    byte_range: None,
                    key: None,
                });
            }
            let url =
                |vars: &mut HashMap<&str, Var>, n: f64, time: f64| -> Result<String, String> {
                    vars.insert("Number", Var::Num(n));
                    vars.insert("Time", Var::Num(time));
                    resolve(&substitute(media, vars), &rep.base_url)
                        .ok_or_else(|| "A segment URL is not allowed".to_string())
                };
            let p_dur = period_duration(m, period);
            // A dynamic manifest has no period end: what exists is decided by the clock (ISO 23009-1 5.3.9.5.3).
            let live = m.kind == DashType::Dynamic && m.availability_start_ms.is_some();
            let elapsed_sec = if live {
                (now_ms - m.availability_start_ms.unwrap_or(0.0)) / 1000.0 - period.start_sec
            } else {
                0.0
            };
            if let Some(tl) = timeline {
                let mut time = tl.first().and_then(|s| s.t).unwrap_or(0.0);
                let mut number = *start_number;
                for (idx, s) in tl.iter().enumerate() {
                    if let Some(t) = s.t {
                        time = t;
                    }
                    let mut repeats = s.r;
                    if repeats < 0.0 {
                        // "until the next S, or the end of the period"
                        let end = tl.get(idx + 1).and_then(|n| n.t).or_else(|| match p_dur {
                            Some(d) => Some(presentation_time_offset + d * timescale),
                            None if live => {
                                Some(presentation_time_offset + elapsed_sec * timescale)
                            }
                            None => None,
                        });
                        let end =
                            end.ok_or("An open-ended timeline needs a known period duration")?;
                        repeats = (((end - time) / s.d).ceil() - 1.0).max(0.0);
                    }
                    let mut k = 0.0;
                    while k <= repeats {
                        let u = url(&mut vars, number, time)?;
                        p.push(u, s.d / timescale, None)?;
                        time += s.d;
                        number += 1.0;
                        k += 1.0;
                    }
                }
            } else if let (Some(d), true, None) = (duration, live, p_dur) {
                // Segment k is complete (available) once its end time has passed; only the time-shift window is kept.
                let seg_sec = d / timescale;
                let latest = (elapsed_sec / seg_sec).floor() - 1.0;
                let depth = m.time_shift_buffer_sec.unwrap_or(60.0);
                let first = (latest - (depth / seg_sec).ceil() + 1.0).max(0.0);
                let mut k = first;
                while k <= latest {
                    let u = url(
                        &mut vars,
                        start_number + k,
                        presentation_time_offset + k * d,
                    )?;
                    p.push(u, seg_sec, None)?;
                    k += 1.0;
                }
            } else if let Some(d) = duration {
                let p_dur =
                    p_dur.ok_or("A duration-based template needs a known period duration")?;
                let count = (p_dur * timescale / d).ceil();
                let mut k = 0.0;
                while k < count {
                    let u = url(
                        &mut vars,
                        start_number + k,
                        presentation_time_offset + k * d,
                    )?;
                    p.push(u, d / timescale, None)?;
                    k += 1.0;
                }
            }
        }
    }
    let mut segments = p.segments;
    if let Some(i) = &init {
        for s in &mut segments {
            s.map = Some(i.clone());
        }
    }
    let sum: f64 = segments.iter().map(|s| s.duration).sum();
    let duration_sec = if sum != 0.0 && !sum.is_nan() {
        sum
    } else {
        period_duration(m, period).unwrap_or(0.0)
    };
    Ok(ExpandedRepresentation {
        init,
        segments,
        duration_sec,
    })
}

/// Everything needed to decide what to do with a protected manifest.
pub fn protections_of(reps: &[DashRepresentation]) -> DashProtections {
    let mut systems: Vec<DashProtectionSystem> = Vec::new();
    for p in reps.iter().flat_map(|r| &r.protections) {
        if !systems.contains(&p.system) {
            systems.push(p.system);
        }
    }
    let clear_key = systems.contains(&DashProtectionSystem::Clearkey)
        && systems.iter().all(|s| {
            matches!(
                s,
                DashProtectionSystem::Clearkey | DashProtectionSystem::Cenc
            )
        });
    DashProtections {
        drm: !systems.is_empty() && !clear_key,
        clear_key,
        systems,
    }
}
