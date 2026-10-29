//! Resource identity and ordering from `src/lib/resources.ts`: ids, merging duplicates, grouping, hiding the variants a
//! master playlist already offers, and the order the popup lists them in.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::dash::parse_dash_ref;
use crate::js::{fnv1a_utf16, hex8};
use crate::obj::{arr_of, defined, num_of, spread, str_of};
use crate::security::normalize_url;

/// Stable, short id derived from the normalised URL (FNV-1a, 32-bit, hex). Not a security hash.
pub fn resource_id(url: &str) -> String {
    let mut s = normalize_url(url);
    // A DASH representation (a subtitle track of a manifest) is a resource of its own: keep it apart from the manifest.
    if parse_dash_ref(url).is_some() {
        if let Some(i) = url.find("#vdh-rep=") {
            s.push('#');
            s.push_str(&url[i + 1..]);
        }
    }
    hex8(fnv1a_utf16(&s))
}

/// Fields that only the incoming resource may know; a missing one keeps the earlier value.
const OPTIONAL: [&str; 14] = [
    "mimeType",
    "sizeBytes",
    "sizeIsEstimate",
    "durationSec",
    "width",
    "height",
    "bitrate",
    "frameRate",
    "codecs",
    "poster",
    "playlist",
    "language",
    "subtitleTracks",
    "ext",
];

fn reason(r: &Value) -> Option<&str> {
    r.get("downloadability").and_then(|d| str_of(d, "reason"))
}

/// Merge a newly probed resource into an existing one with the same id: probed facts from the incoming resource win,
/// detection methods accumulate, the earliest detection time is kept, and a resolved verdict is never replaced by
/// "not probed".
pub fn merge_resource(existing: &Value, incoming: &Value) -> Value {
    let mut merged = spread(existing, incoming);
    let mut methods: Vec<Value> = Vec::new();
    for m in arr_of(existing, "detectedBy")
        .iter()
        .chain(arr_of(incoming, "detectedBy"))
    {
        if !methods.contains(m) {
            methods.push(m.clone());
        }
    }
    merged.insert("detectedBy".into(), Value::Array(methods));
    let (a, b) = (
        num_of(existing, "detectedAt"),
        num_of(incoming, "detectedAt"),
    );
    let earliest = match (a, b) {
        (Some(x), Some(y)) if y < x => incoming.get("detectedAt"),
        (Some(_), Some(_)) => existing.get("detectedAt"),
        _ => None,
    };
    merged.insert(
        "detectedAt".into(),
        earliest.cloned().unwrap_or(Value::Null),
    );
    for list in ["variants", "audioTracks"] {
        let pick = if arr_of(incoming, list).is_empty() {
            existing.get(list)
        } else {
            incoming.get(list)
        };
        set(&mut merged, list, pick);
    }
    let keep = reason(incoming) == Some("not-probed") && reason(existing) != Some("not-probed");
    set(
        &mut merged,
        "downloadability",
        if keep {
            existing.get("downloadability")
        } else {
            incoming.get("downloadability")
        },
    );
    for k in OPTIONAL {
        if let Some(v) = defined(incoming.get(k)).or(existing.get(k)) {
            merged.insert(k.into(), v.clone());
        }
    }
    merged.retain(|_, v| !v.is_null());
    Value::Object(merged)
}

fn set(m: &mut Map<String, Value>, k: &str, v: Option<&Value>) {
    match v {
        Some(v) => m.insert(k.into(), v.clone()),
        None => m.remove(k),
    };
}

/// Deduplicate by id (the normalised URL), merging duplicates; order of first appearance is kept.
pub fn dedupe_resources(list: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for r in list {
        let id = str_of(r, "id").unwrap_or("").to_string();
        match at.get(&id) {
            Some(&i) => out[i] = merge_resource(&out[i], r),
            None => {
                at.insert(id, out.len());
                out.push(r.clone());
            }
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceGroup {
    pub key: String,
    pub title: String,
    pub host: String,
    pub items: Vec<Value>,
}

/// Resources that share a host and a title (a master playlist and its variants) are shown together.
pub fn group_resources(list: &[Value]) -> Vec<ResourceGroup> {
    group_indexes(list)
        .into_iter()
        .map(|g| ResourceGroup {
            key: g.key,
            title: g.title,
            host: g.host,
            items: g.items.iter().map(|i| list[*i].clone()).collect(),
        })
        .collect()
}

/// [`group_resources`] with the items as indexes into `list`.
#[derive(Debug, Clone, Serialize)]
pub struct IndexGroup {
    pub key: String,
    pub title: String,
    pub host: String,
    pub items: Vec<usize>,
}

pub fn group_indexes(list: &[Value]) -> Vec<IndexGroup> {
    let mut groups: Vec<IndexGroup> = Vec::new();
    for (i, r) in list.iter().enumerate() {
        let (host, title) = (
            str_of(r, "host").unwrap_or(""),
            str_of(r, "title").unwrap_or(""),
        );
        let key = format!("{host}::{}", title.to_lowercase());
        match groups.iter_mut().find(|g| g.key == key) {
            Some(g) => g.items.push(i),
            None => groups.push(IndexGroup {
                key,
                title: title.into(),
                host: host.into(),
                items: vec![i],
            }),
        }
    }
    groups
}

/// The variant playlists a master playlist already offers as qualities are hidden (subtitle playlists stay: they are
/// listed as subtitles).
pub fn hide_covered_variants(list: &[Value]) -> Vec<Value> {
    visible_indexes(list)
        .into_iter()
        .map(|i| list[i].clone())
        .collect()
}

/// Indexes of the resources [`hide_covered_variants`] keeps.
pub fn visible_indexes(list: &[Value]) -> Vec<usize> {
    let mut covered: HashSet<String> = HashSet::new();
    for r in list
        .iter()
        .filter(|r| str_of(r, "kind") == Some("hls-master"))
    {
        let lists = [
            arr_of(r, "variants"),
            arr_of(r, "audioTracks"),
            arr_of(r, "subtitleTracks"),
        ];
        for (i, items) in lists.iter().enumerate() {
            for v in *items {
                match str_of(v, "uri") {
                    Some(u) if i == 0 || !u.is_empty() => {
                        covered.insert(resource_id(u));
                    }
                    _ => {}
                }
            }
        }
    }
    list.iter()
        .enumerate()
        .filter(|(_, r)| {
            matches!(str_of(r, "kind"), Some("hls-master" | "subtitle"))
                || !covered.contains(str_of(r, "id").unwrap_or(""))
        })
        .map(|(i, _)| i)
        .collect()
}

/// Tallest picture a resource offers: its own, or the best of its variants.
pub fn best_height(r: &Value) -> f64 {
    arr_of(r, "variants")
        .iter()
        .map(|v| num_of(v, "height").unwrap_or(0.0))
        .fold(num_of(r, "height").unwrap_or(0.0), f64::max)
}

/// What one click on the card does: a real file beats a capture, which beats a recording; refused comes last.
pub fn action_rank(r: &Value) -> f64 {
    let d = r.get("downloadability");
    if d.and_then(|d| str_of(d, "status")) != Some("downloadable") {
        return 0.0;
    }
    match d.and_then(|d| str_of(d, "detail")) {
        Some("stream-recordable" | "live-recordable") => 1.0,
        Some("mse-capturable") => 2.0,
        _ => 3.0,
    }
}

fn media_rank(r: &Value) -> f64 {
    match str_of(r, "mediaType") {
        Some("video") => 2.0,
        Some("unknown") => 1.0,
        _ => 0.0,
    }
}

fn in_frame(r: &Value) -> f64 {
    f64::from(u8::from(num_of(r, "frameId").unwrap_or(0.0) != 0.0))
}

/// The order the user most likely wants: what can be saved with one click first, then video over audio, the highest
/// quality, the longest, the page itself before embedded frames; detection order breaks the remaining ties.
pub fn rank_resources(list: &[Value]) -> Vec<Value> {
    rank_order(list)
        .into_iter()
        .map(|i| list[i].clone())
        .collect()
}

/// The indexes of `list` in [`rank_resources`] order.
pub fn rank_order(list: &[Value]) -> Vec<usize> {
    let keys: [fn(&Value) -> f64; 4] = [action_rank, media_rank, best_height, |r| {
        num_of(r, "durationSec").unwrap_or(0.0)
    }];
    let mut order: Vec<usize> = (0..list.len()).collect();
    order.sort_by(|&i, &j| {
        let (a, b) = (&list[i], &list[j]);
        for key in keys {
            let d = key(b) - key(a);
            if d != 0.0 && !d.is_nan() {
                return if d > 0.0 {
                    Ordering::Greater
                } else {
                    Ordering::Less
                };
            }
        }
        in_frame(a)
            .partial_cmp(&in_frame(b))
            .unwrap_or(Ordering::Equal)
            .then(i.cmp(&j))
    });
    order
}

/// The card worth putting first: only when there is a choice to make and the top one can actually be saved.
pub fn best_match(ranked: &[Value]) -> Option<&Value> {
    let top = ranked.first()?;
    (ranked.len() >= 2 && action_rank(top) > 0.0).then_some(top)
}
