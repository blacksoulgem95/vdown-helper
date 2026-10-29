//! Reading just enough of fragmented MP4 and WebM to organise what a player appends to a MediaSource
//! (`src/lib/mse.ts` and `src/lib/mseParts.ts`): which chunks are initialisation segments, what tracks they define,
//! where in time each media segment starts, and how a capture splits into files that need no re-encoding.
//!
//! Input comes from a hostile page: every read is bounds-checked (a read past the end gives 0, as in the TypeScript)
//! and nothing fails; what cannot be made sense of is `None`. Offsets are `f64` like JavaScript numbers, so oversized
//! boxes behave the same on both sides.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::js::{hex8, number_to_string, round};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrackInfo {
    /// Track id inside the container.
    pub id: f64,
    /// `video`, `audio` or `other`.
    pub kind: String,
    /// Sample entry (MP4: "avc1", "vp09", "mp4a", "Opus" ...) or CodecID (WebM: "V_VP9", "A_OPUS" ...).
    pub codec: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    /// Ticks per second of the track's timestamps (MP4 mdhd; WebM: 1e9 / TimecodeScale).
    pub timescale: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InitInfo {
    /// `mp4` or `webm`.
    pub container: String,
    pub tracks: Vec<TrackInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentStart {
    pub track_id: f64,
    pub ticks: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FragmentInfo {
    pub container: String,
    /// Start of the first sample, per track, in the track's own ticks (WebM: Cluster Timecode, track 0 = all).
    pub starts: Vec<FragmentStart>,
}

const MAX_BOXES: usize = 4096;

fn at(b: &[u8], o: f64) -> f64 {
    if o >= 0.0 && o < b.len() as f64 {
        f64::from(b[o as usize])
    } else {
        0.0
    }
}

fn byte(b: &[u8], o: f64) -> Option<u8> {
    (o >= 0.0 && o < b.len() as f64).then(|| b[o as usize])
}

fn u32_at(b: &[u8], o: f64) -> f64 {
    ((at(b, o) * 256.0 + at(b, o + 1.0)) * 256.0 + at(b, o + 2.0)) * 256.0 + at(b, o + 3.0)
}

fn u16_at(b: &[u8], o: f64) -> f64 {
    at(b, o) * 256.0 + at(b, o + 1.0)
}

fn u64_at(b: &[u8], o: f64) -> f64 {
    u32_at(b, o) * 4_294_967_296.0 + u32_at(b, o + 4.0)
}

/// `String.fromCharCode` of four bytes (Latin-1).
fn fourcc(b: &[u8], o: f64) -> String {
    (0..4)
        .map(|i| char::from(at(b, o + f64::from(i)) as u8))
        .collect()
}

// ---------------------------------------------------------------------------------------------------------------
// ISO base media file format (fragmented MP4)

#[derive(Debug, Clone)]
struct Mp4Box {
    ty: String,
    /// Offset of the box header.
    start: f64,
    /// Offset of the box body (after the header) and its end, clamped to the buffer.
    body: f64,
    end: f64,
}

fn boxes(b: &[u8], from: f64, to: f64) -> Vec<Mp4Box> {
    let mut out = Vec::new();
    let mut pos = from;
    while pos + 8.0 <= to && out.len() < MAX_BOXES {
        let mut size = u32_at(b, pos);
        let ty = fourcc(b, pos + 4.0);
        let mut header = 8.0;
        if size == 1.0 {
            if pos + 16.0 > to {
                break;
            }
            size = u64_at(b, pos + 8.0);
            header = 16.0;
        } else if size == 0.0 {
            size = to - pos;
        }
        if size < header || !size.is_finite() {
            break;
        }
        out.push(Mp4Box {
            ty,
            start: pos,
            body: pos + header,
            end: (pos + size).min(to),
        });
        pos += size;
    }
    out
}

fn child(b: &[u8], parent: &Mp4Box, ty: &str) -> Option<Mp4Box> {
    boxes(b, parent.body, parent.end)
        .into_iter()
        .find(|x| x.ty == ty)
}

/// Version 1 boxes carry 64-bit times, which moves the field read after them.
fn versioned(b: &[u8], body: f64, v0: f64, v1: f64) -> f64 {
    body + if at(b, body) == 1.0 { v1 } else { v0 }
}

fn parse_mp4_track(b: &[u8], trak: &Mp4Box) -> Option<TrackInfo> {
    let tkhd = child(b, trak, "tkhd")?;
    let mdia = child(b, trak, "mdia")?;
    let id = u32_at(b, versioned(b, tkhd.body, 12.0, 20.0));
    let mdhd = child(b, &mdia, "mdhd")?;
    let hdlr = child(b, &mdia, "hdlr")?;
    let timescale = u32_at(b, versioned(b, mdhd.body, 12.0, 20.0));
    let kind = match fourcc(b, hdlr.body + 8.0).as_str() {
        "vide" => "video",
        "soun" => "audio",
        _ => "other",
    };
    let mut codec = String::new();
    let (mut width, mut height) = (None, None);
    let stsd = child(b, &mdia, "minf")
        .and_then(|minf| child(b, &minf, "stbl"))
        .and_then(|stbl| child(b, &stbl, "stsd"));
    if let Some(stsd) = stsd.filter(|s| s.body + 8.0 + 8.0 <= s.end) {
        let entry = stsd.body + 8.0; // after version/flags and entry_count
        codec = fourcc(b, entry + 4.0);
        if kind == "video" && entry + 36.0 <= stsd.end {
            width = Some(u16_at(b, entry + 32.0)).filter(|w| *w != 0.0);
            height = Some(u16_at(b, entry + 34.0)).filter(|h| *h != 0.0);
        }
    }
    if id == 0.0 || timescale == 0.0 {
        return None;
    }
    Some(TrackInfo {
        id,
        kind: kind.into(),
        codec,
        width,
        height,
        timescale,
    })
}

fn parse_mp4_init(b: &[u8]) -> Option<InitInfo> {
    let moov = boxes(b, 0.0, b.len() as f64)
        .into_iter()
        .find(|x| x.ty == "moov")?;
    let tracks: Vec<TrackInfo> = boxes(b, moov.body, moov.end)
        .iter()
        .filter(|x| x.ty == "trak")
        .filter_map(|t| parse_mp4_track(b, t))
        .collect();
    (!tracks.is_empty()).then(|| InitInfo {
        container: "mp4".into(),
        tracks,
    })
}

fn parse_mp4_fragment(b: &[u8]) -> Option<FragmentInfo> {
    let mut starts = Vec::new();
    for moof in boxes(b, 0.0, b.len() as f64)
        .iter()
        .filter(|x| x.ty == "moof")
    {
        for traf in boxes(b, moof.body, moof.end)
            .iter()
            .filter(|x| x.ty == "traf")
        {
            let (Some(tfhd), Some(tfdt)) = (child(b, traf, "tfhd"), child(b, traf, "tfdt")) else {
                continue;
            };
            starts.push(FragmentStart {
                track_id: u32_at(b, tfhd.body + 4.0),
                ticks: if at(b, tfdt.body) == 1.0 {
                    u64_at(b, tfdt.body + 4.0)
                } else {
                    u32_at(b, tfdt.body + 4.0)
                },
            });
        }
    }
    (!starts.is_empty()).then(|| FragmentInfo {
        container: "mp4".into(),
        starts,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// WebM (Matroska subset)

struct Vint {
    value: f64,
    length: f64,
    /// Size field with all value bits set: "unknown size" (live-style segments and clusters).
    unknown: bool,
}

fn vint(b: &[u8], pos: f64, keep_marker: bool) -> Option<Vint> {
    let first = byte(b, pos).filter(|f| *f != 0)?;
    let length = first.leading_zeros() + 1; // 1..=8 for a non-zero byte
    if pos + f64::from(length) > b.len() as f64 {
        return None;
    }
    let mask = if length >= 8 { 0 } else { 0xff_u8 >> length };
    let mut value = f64::from(if keep_marker { first } else { first & mask });
    let mut all_ones = first & mask == mask;
    for i in 1..length {
        let x = at(b, pos + f64::from(i));
        value = value * 256.0 + x;
        if x != 255.0 {
            all_ones = false;
        }
    }
    Some(Vint {
        value,
        length: f64::from(length),
        unknown: !keep_marker && all_ones,
    })
}

struct Ebml {
    id: f64,
    body: f64,
    end: f64,
}

fn ebml_children(b: &[u8], from: f64, to: f64) -> Vec<Ebml> {
    let mut out = Vec::new();
    let mut pos = from;
    while pos < to && out.len() < MAX_BOXES {
        let Some(id) = vint(b, pos, true) else { break };
        let Some(size) = vint(b, pos + id.length, false) else {
            break;
        };
        let body = pos + id.length + size.length;
        let end = if size.unknown {
            to
        } else {
            (body + size.value).min(to)
        };
        out.push(Ebml {
            id: id.value,
            body,
            end,
        });
        if size.unknown {
            break; // everything after it is inside it
        }
        pos = end;
    }
    out
}

fn uint(b: &[u8], e: &Ebml) -> f64 {
    let mut v = 0.0;
    let mut i = e.body;
    while i < e.end && i < e.body + 8.0 {
        v = v * 256.0 + at(b, i);
        i += 1.0;
    }
    v
}

fn ebml_str(b: &[u8], e: &Ebml) -> String {
    let mut s = String::new();
    let mut i = e.body;
    while i < e.end.min(e.body + 40.0) && i < b.len() as f64 {
        s.push(char::from(at(b, i) as u8));
        i += 1.0;
    }
    s
}

mod id {
    pub const EBML: f64 = 440_786_851.0; // 0x1a45dfa3
    pub const SEGMENT: f64 = 408_125_543.0; // 0x18538067
    pub const INFO: f64 = 357_149_030.0; // 0x1549a966
    pub const TIMECODE_SCALE: f64 = 2_807_729.0; // 0x2ad7b1
    pub const TRACKS: f64 = 374_648_427.0; // 0x1654ae6b
    pub const TRACK_ENTRY: f64 = 174.0; // 0xae
    pub const TRACK_NUMBER: f64 = 215.0; // 0xd7
    pub const TRACK_TYPE: f64 = 131.0; // 0x83
    pub const CODEC_ID: f64 = 134.0; // 0x86
    pub const VIDEO: f64 = 224.0; // 0xe0
    pub const PIXEL_WIDTH: f64 = 176.0; // 0xb0
    pub const PIXEL_HEIGHT: f64 = 186.0; // 0xba
    pub const CLUSTER: f64 = 524_531_317.0; // 0x1f43b675
    pub const TIMECODE: f64 = 231.0; // 0xe7
}

fn find(list: &[Ebml], want: f64) -> Option<&Ebml> {
    list.iter().find(|e| e.id == want)
}

fn parse_webm_init(b: &[u8]) -> Option<InitInfo> {
    let top = ebml_children(b, 0.0, b.len() as f64);
    if top.first()?.id != id::EBML {
        return None;
    }
    let segment = find(&top, id::SEGMENT)?;
    let kids = ebml_children(b, segment.body, segment.end);
    let scale_ns = find(&kids, id::INFO)
        .and_then(|info| {
            let fields = ebml_children(b, info.body, info.end);
            find(&fields, id::TIMECODE_SCALE).map(|e| uint(b, e))
        })
        .map_or(1_000_000.0, |s| if s == 0.0 { 1_000_000.0 } else { s });
    let tracks_el = find(&kids, id::TRACKS)?;
    let mut tracks: Vec<TrackInfo> = Vec::new();
    for entry in ebml_children(b, tracks_el.body, tracks_el.end)
        .iter()
        .filter(|e| e.id == id::TRACK_ENTRY)
    {
        let f = ebml_children(b, entry.body, entry.end);
        let vf = find(&f, id::VIDEO).map_or_else(Vec::new, |v| ebml_children(b, v.body, v.end));
        let kind = match find(&f, id::TRACK_TYPE).map(|t| uint(b, t)) {
            Some(1.0) => "video",
            Some(2.0) => "audio",
            _ => "other",
        };
        tracks.push(TrackInfo {
            id: find(&f, id::TRACK_NUMBER).map_or(tracks.len() as f64 + 1.0, |n| uint(b, n)),
            kind: kind.into(),
            codec: find(&f, id::CODEC_ID).map_or_else(String::new, |c| ebml_str(b, c)),
            timescale: 1e9 / scale_ns,
            width: find(&vf, id::PIXEL_WIDTH).map(|w| uint(b, w)),
            height: find(&vf, id::PIXEL_HEIGHT).map(|h| uint(b, h)),
        });
    }
    (!tracks.is_empty()).then(|| InitInfo {
        container: "webm".into(),
        tracks,
    })
}

fn parse_webm_fragment(b: &[u8]) -> Option<FragmentInfo> {
    let top = ebml_children(b, 0.0, b.len() as f64);
    let cluster = find(&top, id::CLUSTER)?;
    let fields = ebml_children(b, cluster.body, cluster.end);
    let tc = find(&fields, id::TIMECODE)?;
    Some(FragmentInfo {
        container: "webm".into(),
        starts: vec![FragmentStart {
            track_id: 0.0,
            ticks: uint(b, tc),
        }],
    })
}

/// Initialisation segment (what the tracks are), or `None` if this chunk is not one.
pub fn parse_init(data: &[u8]) -> Option<InitInfo> {
    parse_mp4_init(data).or_else(|| parse_webm_init(data))
}

/// Media segment (where it starts), or `None` if this chunk is not one.
pub fn parse_fragment(data: &[u8]) -> Option<FragmentInfo> {
    parse_mp4_fragment(data).or_else(|| parse_webm_fragment(data))
}

/// Where the media starts inside a chunk that holds an initialisation segment and the first media segment (the first
/// `moof`, or the first WebM Cluster), or `None` when the chunk is not such a mixture.
pub fn media_start_in_init(data: &[u8]) -> Option<usize> {
    let bs = boxes(data, 0.0, data.len() as f64);
    if bs.iter().any(|x| x.ty == "moov") {
        let mut first = bs.iter().position(|x| x.ty == "moof")?;
        // a styp/sidx right before the moof belongs to the media segment
        while first > 0 && matches!(bs[first - 1].ty.as_str(), "styp" | "sidx") {
            first -= 1;
        }
        let start = bs[first].start;
        return (start > 0.0).then_some(start as usize);
    }
    if data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        let top = ebml_children(data, 0.0, data.len() as f64);
        let segment = find(&top, id::SEGMENT)?;
        return first_cluster_start(data, segment.body);
    }
    None
}

fn first_cluster_start(b: &[u8], from: f64) -> Option<usize> {
    let mut pos = from;
    let mut n = 0;
    while n < MAX_BOXES && pos < b.len() as f64 {
        let id = vint(b, pos, true)?;
        let size = vint(b, pos + id.length, false)?;
        if id.value == id::CLUSTER {
            return Some(pos as usize);
        }
        if size.unknown {
            return None;
        }
        pos += id.length + size.length + size.value;
        n += 1;
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------
// Chunks and parts

/// What is known about one chunk a player appended to a SourceBuffer. The bytes themselves live on disk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkMeta {
    /// SourceBuffer the chunk went to (the hook's id).
    pub track: String,
    /// Arrival order across the whole capture.
    pub seq: f64,
    /// `init` or `media`.
    pub kind: String,
    /// Where the chunk sits in its track's staged file.
    pub offset: f64,
    pub length: f64,
    /// Content signature: equal chunks have equal signatures.
    pub sig: String,
    /// Media chunks: where the segment starts on the media timeline, in seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_sec: Option<f64>,
    /// Init chunks: what the tracks are.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init: Option<InitInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

/// FNV-1a over the length, the head and the tail: cheap, and enough to recognise a segment appended twice.
pub fn chunk_signature(b: &[u8]) -> String {
    let mut h: u32 = 0x811c_9dc5;
    let mut mix = |v: u32| h = (h ^ v).wrapping_mul(0x0100_0193);
    let len = b.len() as u32;
    for shift in [0, 8, 16, 24] {
        mix((len >> shift) & 0xff);
    }
    let edge = 4096;
    for x in &b[..b.len().min(edge)] {
        mix(u32::from(*x));
    }
    for x in &b[edge.max(b.len().saturating_sub(edge)).min(b.len())..] {
        mix(u32::from(*x));
    }
    hex8(h)
}

/// One append classified, given the latest initialisation segment of its SourceBuffer.
pub fn classify(
    track: &str,
    seq: f64,
    bytes: &[u8],
    offset: f64,
    known: Option<&InitInfo>,
) -> ChunkMeta {
    let mut meta = ChunkMeta {
        track: track.into(),
        seq,
        kind: "media".into(),
        offset,
        length: bytes.len() as f64,
        sig: chunk_signature(bytes),
        start_sec: None,
        init: None,
        container: None,
    };
    if let Some(init) = parse_init(bytes) {
        meta.kind = "init".into();
        meta.container = Some(init.container.clone());
        meta.init = Some(init);
        return meta;
    }
    let frag = parse_fragment(bytes);
    if let (Some(frag), Some(known)) = (&frag, known) {
        for s in &frag.starts {
            // WebM clusters carry one timecode for every track; MP4 names its track
            let Some(t) = known
                .tracks
                .iter()
                .find(|x| x.id == s.track_id)
                .or(known.tracks.first())
            else {
                continue;
            };
            if t.timescale == 0.0 || t.timescale.is_nan() {
                continue;
            }
            let sec = s.ticks / t.timescale;
            meta.start_sec = Some(meta.start_sec.map_or(sec, |m| m.min(sec)));
        }
    }
    meta.container = Some(
        frag.map(|f| f.container)
            .or_else(|| known.map(|k| k.container.clone()))
            .unwrap_or_else(|| "mp4".into()),
    );
    meta
}

/// One append classified. A player that appends the initialisation segment together with the first media segment
/// gets two entries (the bytes stay contiguous on disk, so offsets and lengths simply divide the chunk).
pub fn classify_all(
    track: &str,
    seq: f64,
    bytes: &[u8],
    offset: f64,
    known: Option<&InitInfo>,
) -> Vec<ChunkMeta> {
    let Some(cut) = media_start_in_init(bytes) else {
        return vec![classify(track, seq, bytes, offset, known)];
    };
    let first = classify(track, seq, &bytes[..cut], offset, known);
    let known = first.init.clone().or_else(|| known.cloned());
    let second = classify(
        track,
        seq,
        &bytes[cut..],
        offset + cut as f64,
        known.as_ref(),
    );
    vec![first, second]
}

/// Classifies chunks as they arrive, remembering each SourceBuffer's latest initialisation segment.
#[derive(Debug, Default)]
pub struct ChunkClassifier {
    inits: HashMap<String, InitInfo>,
}

impl ChunkClassifier {
    pub fn classify_all(
        &mut self,
        track: &str,
        seq: f64,
        bytes: &[u8],
        offset: f64,
    ) -> Vec<ChunkMeta> {
        let metas = classify_all(track, seq, bytes, offset, self.inits.get(track));
        for m in &metas {
            if let Some(init) = &m.init {
                self.inits.insert(track.into(), init.clone());
            }
        }
        metas
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PartTrack {
    pub track: String,
    /// `video`, `audio` or `muxed`.
    pub role: String,
    /// The initialisation segment to start the file with, then the media segments in time order.
    pub chunks: Vec<ChunkMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub index: usize,
    pub container: String,
    /// Media time covered by the video of this part (seconds; the last part ends at infinity).
    pub start_sec: f64,
    pub end_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<TrackInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<TrackInfo>,
    pub tracks: Vec<PartTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PartPlan {
    pub parts: Vec<Part>,
    /// Media chunks that arrived before any initialisation segment of their SourceBuffer and cannot be used.
    pub orphans: usize,
    /// Chunks left out because the same segment was appended more than once.
    pub duplicates: usize,
}

fn init_tracks(m: &ChunkMeta) -> &[TrackInfo] {
    m.init.as_ref().map_or(&[], |i| i.tracks.as_slice())
}

fn has_kind(m: &ChunkMeta, k: &str) -> bool {
    init_tracks(m).iter().any(|t| t.kind == k)
}

fn first_of_kind(m: &ChunkMeta, k: &str) -> Option<TrackInfo> {
    init_tracks(m).iter().find(|t| t.kind == k).cloned()
}

fn time_order(a: &ChunkMeta, b: &ChunkMeta) -> std::cmp::Ordering {
    let (x, y) = (
        a.start_sec.unwrap_or(f64::INFINITY),
        b.start_sec.unwrap_or(f64::INFINITY),
    );
    if x == y {
        a.seq.partial_cmp(&b.seq)
    } else {
        x.partial_cmp(&y)
    }
    .unwrap_or(std::cmp::Ordering::Equal)
}

/// The same segment appended again (a seek, a retry): keep the first copy.
fn dedupe(mut list: Vec<ChunkMeta>) -> (Vec<ChunkMeta>, usize) {
    list.sort_by(time_order);
    let mut seen = std::collections::HashSet::new();
    let total = list.len();
    let kept: Vec<ChunkMeta> = list
        .into_iter()
        .filter(|m| {
            let key = match m.start_sec {
                Some(s) => format!("t{}", number_to_string(round(s * 1000.0))),
                None => format!("s{}", m.sig),
            };
            seen.insert(key)
        })
        .collect();
    let dropped = total - kept.len();
    (kept, dropped)
}

fn media_bytes(list: &[ChunkMeta]) -> f64 {
    list.iter()
        .filter(|m| m.kind == "media")
        .map(|m| m.length)
        .sum()
}

/// Split a capture into parts. A new part starts whenever the video's initialisation segment changes (the player moved
/// to another quality): the two cannot share a file without re-encoding, and this never re-encodes. Audio, which
/// usually does not change, is placed in the part whose video covers its start time. Every part begins with the
/// initialisation segments it needs and holds each segment once, in time order.
pub fn plan_parts(metas: &[ChunkMeta]) -> PartPlan {
    let mut sorted: Vec<&ChunkMeta> = metas.iter().collect();
    sorted.sort_by(|a, b| {
        a.seq
            .partial_cmp(&b.seq)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut by_track: Vec<(String, Vec<ChunkMeta>)> = Vec::new();
    for m in sorted {
        match by_track.iter_mut().find(|(t, _)| *t == m.track) {
            Some((_, l)) => l.push(m.clone()),
            None => by_track.push((m.track.clone(), vec![m.clone()])),
        }
    }
    let role_of = |list: &[ChunkMeta]| -> Option<&'static str> {
        let init = list.iter().rev().find(|m| m.kind == "init")?;
        match (has_kind(init, "video"), has_kind(init, "audio")) {
            (true, true) => Some("muxed"),
            (true, false) => Some("video"),
            (false, true) => Some("audio"),
            _ => None,
        }
    };
    let roles: Vec<Option<&'static str>> = by_track.iter().map(|(_, l)| role_of(l)).collect();
    // The track that defines the parts: the video-bearing SourceBuffer with the most data.
    let mut candidates: Vec<usize> = (0..by_track.len())
        .filter(|i| matches!(roles[*i], Some("video" | "muxed")))
        .collect();
    candidates.sort_by(|a, b| {
        media_bytes(&by_track[*b].1)
            .partial_cmp(&media_bytes(&by_track[*a].1))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let primary = candidates.first().copied();
    let mut orphans: usize = (0..by_track.len())
        .filter(|i| roles[*i].is_none())
        .map(|i| by_track[i].1.iter().filter(|m| m.kind == "media").count())
        .sum();
    let mut duplicates = 0;

    struct Draft {
        init: ChunkMeta,
        media: Vec<ChunkMeta>,
    }
    let mut drafts: Vec<Draft> = Vec::new();
    let audio_tracks: Vec<usize> = (0..by_track.len())
        .filter(|i| roles[*i] == Some("audio"))
        .collect();

    if let Some(p) = primary {
        for m in &by_track[p].1 {
            if m.kind == "init" {
                match drafts.last_mut() {
                    Some(cur) if cur.init.sig == m.sig => {} // the same init appended again
                    Some(cur) if cur.media.is_empty() => cur.init = m.clone(), // nothing recorded under the previous one
                    _ => drafts.push(Draft {
                        init: m.clone(),
                        media: Vec::new(),
                    }),
                }
            } else if let Some(cur) = drafts.last_mut() {
                cur.media.push(m.clone());
            } else {
                orphans += 1;
            }
        }
    }

    let mut parts: Vec<Part> = Vec::new();
    let starts: Vec<f64> = drafts
        .iter()
        .map(|d| {
            d.media
                .iter()
                .map(|m| m.start_sec.unwrap_or(f64::INFINITY))
                .fold(f64::INFINITY, f64::min)
        })
        .collect();
    for (i, d) in drafts.iter().enumerate() {
        if d.media.is_empty() {
            continue;
        }
        let (kept, dropped) = dedupe(d.media.clone());
        duplicates += dropped;
        let start_sec = if starts[i].is_finite() {
            starts[i]
        } else {
            0.0
        };
        let end_sec = starts[i + 1..]
            .iter()
            .copied()
            .find(|s| s.is_finite())
            .unwrap_or(f64::INFINITY);
        let p = primary.unwrap_or(0);
        let primary_role = roles[p].unwrap_or("video");
        let mut chunks = vec![d.init.clone()];
        chunks.extend(kept);
        let mut tracks = vec![PartTrack {
            track: by_track[p].0.clone(),
            role: primary_role.into(),
            chunks,
        }];
        for &a in &audio_tracks {
            let list = &by_track[a].1;
            let inits: Vec<&ChunkMeta> = list.iter().filter(|m| m.kind == "init").collect();
            let mine: Vec<ChunkMeta> = list
                .iter()
                .filter(|m| m.kind == "media")
                .filter(|m| {
                    let s = m.start_sec.unwrap_or(start_sec);
                    s >= start_sec && s < end_sec
                })
                .cloned()
                .collect();
            if mine.is_empty() {
                continue;
            }
            let first = mine.iter().map(|m| m.seq).fold(f64::INFINITY, f64::min);
            // the audio init in force when this part's first audio segment was appended
            let Some(init) = inits.iter().rev().find(|m| m.seq < first).or(inits.first()) else {
                orphans += mine.len();
                continue;
            };
            let (kept, dropped) = dedupe(mine);
            duplicates += dropped;
            let mut chunks = vec![(*init).clone()];
            chunks.extend(kept);
            tracks.push(PartTrack {
                track: by_track[a].0.clone(),
                role: "audio".into(),
                chunks,
            });
        }
        let video_init = &d.init;
        let audio_init = tracks
            .iter()
            .find(|t| t.role == "audio")
            .and_then(|t| t.chunks.first())
            .or((primary_role == "muxed").then_some(video_init));
        parts.push(Part {
            index: parts.len(),
            container: video_init.container.clone().unwrap_or_else(|| "mp4".into()),
            start_sec,
            end_sec,
            video: first_of_kind(video_init, "video"),
            audio: audio_init.and_then(|m| first_of_kind(m, "audio")),
            tracks,
        });
    }

    // Audio-only capture: no video-bearing SourceBuffer, one part from the audio SourceBuffer with the most data
    if primary.is_none() && !audio_tracks.is_empty() {
        let mut by_size = audio_tracks.clone();
        by_size.sort_by(|a, b| {
            media_bytes(&by_track[*b].1)
                .partial_cmp(&media_bytes(&by_track[*a].1))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let (t, list) = &by_track[by_size[0]];
        let init = list.iter().find(|m| m.kind == "init");
        let (kept, dropped) = dedupe(list.iter().filter(|m| m.kind == "media").cloned().collect());
        duplicates += dropped;
        if let Some(init) = init.filter(|_| !kept.is_empty()) {
            let start_sec = kept[0].start_sec.unwrap_or(0.0);
            let mut chunks = vec![init.clone()];
            chunks.extend(kept);
            parts.push(Part {
                index: 0,
                container: init.container.clone().unwrap_or_else(|| "mp4".into()),
                start_sec,
                end_sec: f64::INFINITY,
                video: None,
                audio: first_of_kind(init, "audio"),
                tracks: vec![PartTrack {
                    track: t.clone(),
                    role: "audio".into(),
                    chunks,
                }],
            });
        }
    }
    PartPlan {
        parts,
        orphans,
        duplicates,
    }
}
