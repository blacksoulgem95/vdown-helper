//! How the popup lists resources, from `src/lib/tabs.ts`: tabs, the image size filter and frame groups.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::obj::{num_of, str_of};
use crate::url::{host, parse_url};

pub const TAB_ORDER: [&str; 6] = ["video", "audio", "subtitles", "images", "files", "assets"];

/// The tab a resource is listed under.
pub fn tab_of(r: &Value) -> &'static str {
    match str_of(r, "kind") {
        Some("subtitle") => "subtitles",
        Some("image") => "images",
        Some("document" | "archive") => "files",
        Some("asset") => "assets",
        _ if str_of(r, "mediaType") == Some("audio") => "audio",
        _ => "video",
    }
}

pub fn split_by_tab(resources: &[Value]) -> Map<String, Value> {
    let mut out: Map<String, Value> = TAB_ORDER
        .iter()
        .map(|k| ((*k).to_string(), Value::Array(Vec::new())))
        .collect();
    for r in resources {
        if let Some(Value::Array(list)) = out.get_mut(tab_of(r)) {
            list.push(r.clone());
        }
    }
    out
}

/// The preferred tab while it has something in it, else the first tab that does.
pub fn active_tab(counts: &Value, preferred: Option<&str>) -> &'static str {
    let has = |k: &str| num_of(counts, k).is_some_and(|n| n > 0.0);
    if let Some(p) = preferred.and_then(|p| TAB_ORDER.iter().find(|k| **k == p)) {
        if has(p) {
            return p;
        }
    }
    TAB_ORDER
        .iter()
        .find(|k| has(k))
        .copied()
        .unwrap_or("video")
}

/// Images below the size filter are hidden; the shorter side decides, and an image of unknown size is kept.
pub fn image_meets_minimum(r: &Value, min_px: f64) -> bool {
    let size = |k| num_of(r, k).filter(|n| *n != 0.0 && !n.is_nan());
    match (size("width"), size("height")) {
        (Some(w), Some(h)) if min_px > 0.0 => w.min(h) >= min_px,
        _ => true,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameGroup {
    /// 0 for the top page.
    pub frame_id: f64,
    /// Host of the frame's document; empty for the top page.
    pub host: String,
    pub items: Vec<Value>,
}

/// Items grouped by the frame they were found in: the top page first, then in order of first appearance.
pub fn group_by_frame(items: &[Value]) -> Vec<FrameGroup> {
    frame_groups(items)
        .into_iter()
        .map(|g| FrameGroup {
            frame_id: g.frame_id,
            host: g.host,
            items: g.items.iter().map(|i| items[*i].clone()).collect(),
        })
        .collect()
}

/// [`group_by_frame`] with the items as indexes into `items`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameIndexGroup {
    pub frame_id: f64,
    pub host: String,
    pub items: Vec<usize>,
}

pub fn frame_groups(items: &[Value]) -> Vec<FrameIndexGroup> {
    let mut groups: Vec<FrameIndexGroup> = Vec::new();
    for (i, r) in items.iter().enumerate() {
        let id = num_of(r, "frameId").unwrap_or(0.0);
        match groups.iter_mut().find(|g| g.frame_id == id) {
            Some(g) => g.items.push(i),
            None => groups.push(FrameIndexGroup {
                frame_id: id,
                host: if id == 0.0 {
                    String::new()
                } else {
                    parse_url(str_of(r, "frameUrl").unwrap_or(""), None)
                        .map(|u| host(&u))
                        .unwrap_or_default()
                },
                items: vec![i],
            }),
        }
    }
    groups.sort_by_key(|g| g.frame_id != 0.0);
    groups
}

/// Why the popup has nothing to offer, which decides the one button the empty state shows.
pub fn empty_cause(error: bool, blocked_frames: f64, reload_pending: bool) -> &'static str {
    if error {
        "error"
    } else if blocked_frames > 0.0 {
        "blocked-frames"
    } else if reload_pending {
        "reload"
    } else {
        "nothing"
    }
}
