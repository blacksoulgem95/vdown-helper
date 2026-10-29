//! Settings validation (`src/lib/settings.ts`): arbitrary stored data in, a complete in-range object out. Loading and
//! saving (`chrome.storage`) stay in TypeScript.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js;
use crate::security::sanitize_subfolder;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: f64,
    pub default_mode: String,
    pub default_container: String,
    pub preferred_quality: String,
    pub default_audio_format: String,
    pub default_audio_bitrate: f64,
    pub naming_template: String,
    pub subfolder: String,
    pub ask_where_to_save: bool,
    pub auto_scan: bool,
    pub page_hook: bool,
    pub network_observer: bool,
    pub image_min_px: f64,
    pub max_concurrent_downloads: f64,
    pub segment_concurrency: f64,
    pub max_memory_mb: f64,
    pub max_encode_duration_sec: f64,
    pub record_container: String,
    pub record_max_minutes: f64,
    pub record_max_mb: f64,
    pub notify_on_complete: bool,
    pub notify_on_error: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: 1.0,
            default_mode: "video-audio".into(),
            default_container: "mp4".into(),
            preferred_quality: "highest".into(),
            default_audio_format: "mp3".into(),
            default_audio_bitrate: 192.0,
            naming_template: "{title} [{resolution}]".into(),
            subfolder: String::new(),
            ask_where_to_save: false,
            auto_scan: false,
            page_hook: true,
            network_observer: false,
            image_min_px: 100.0,
            max_concurrent_downloads: 2.0,
            segment_concurrency: 4.0,
            max_memory_mb: 2048.0,
            max_encode_duration_sec: 0.0,
            record_container: "webm".into(),
            record_max_minutes: 120.0,
            record_max_mb: 4096.0,
            notify_on_complete: true,
            notify_on_error: true,
        }
    }
}

fn one_of_str(v: Option<&Value>, allowed: &[&str], fallback: &str) -> String {
    match v.and_then(Value::as_str) {
        Some(s) if allowed.contains(&s) => s.to_string(),
        _ => fallback.to_string(),
    }
}

fn one_of_num(v: Option<&Value>, allowed: &[f64], fallback: f64) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if v.is_some_and(Value::is_number) && allowed.contains(&n) => n,
        _ => fallback,
    }
}

fn boolean(v: Option<&Value>, fallback: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(fallback)
}

fn int(v: Option<&Value>, min: f64, max: f64, fallback: f64) -> f64 {
    match v.filter(|v| v.is_number()).and_then(Value::as_f64) {
        Some(n) if n.is_finite() => js::round(n).clamp(min, max),
        _ => fallback,
    }
}

/// Validates arbitrary stored data into a complete, in-range Settings object. Unknown keys are dropped.
pub fn sanitize_settings(raw: &Value) -> Settings {
    let empty = Map::new();
    let r = raw.as_object().unwrap_or(&empty);
    let get = |k: &str| r.get(k);
    let d = Settings::default();
    let template = match get("namingTemplate").and_then(Value::as_str) {
        Some(t) if !js::trim(t).is_empty() => js::slice_utf16(t, 200).to_string(),
        _ => d.naming_template.clone(),
    };
    Settings {
        schema_version: 1.0,
        default_mode: one_of_str(
            get("defaultMode"),
            &["video-audio", "audio-only", "video-only", "original"],
            &d.default_mode,
        ),
        default_container: one_of_str(
            get("defaultContainer"),
            &["mp4", "original"],
            &d.default_container,
        ),
        preferred_quality: one_of_str(
            get("preferredQuality"),
            &["highest", "2160", "1440", "1080", "720", "480", "360"],
            &d.preferred_quality,
        ),
        default_audio_format: one_of_str(
            get("defaultAudioFormat"),
            &["mp3", "m4a", "aac", "wav"],
            &d.default_audio_format,
        ),
        default_audio_bitrate: one_of_num(
            get("defaultAudioBitrate"),
            &[128.0, 192.0, 256.0, 320.0],
            d.default_audio_bitrate,
        ),
        naming_template: template,
        subfolder: get("subfolder")
            .and_then(Value::as_str)
            .map_or(d.subfolder.clone(), sanitize_subfolder),
        ask_where_to_save: boolean(get("askWhereToSave"), d.ask_where_to_save),
        auto_scan: boolean(get("autoScan"), d.auto_scan),
        page_hook: boolean(get("pageHook"), d.page_hook),
        network_observer: boolean(get("networkObserver"), d.network_observer),
        image_min_px: one_of_num(
            get("imageMinPx"),
            &[0.0, 100.0, 300.0, 800.0],
            d.image_min_px,
        ),
        max_concurrent_downloads: int(
            get("maxConcurrentDownloads"),
            1.0,
            5.0,
            d.max_concurrent_downloads,
        ),
        segment_concurrency: int(get("segmentConcurrency"), 1.0, 8.0, d.segment_concurrency),
        max_memory_mb: int(get("maxMemoryMb"), 128.0, 8192.0, d.max_memory_mb),
        max_encode_duration_sec: int(
            get("maxEncodeDurationSec"),
            0.0,
            86_400.0,
            d.max_encode_duration_sec,
        ),
        record_container: one_of_str(
            get("recordContainer"),
            &["webm", "mp4"],
            &d.record_container,
        ),
        record_max_minutes: int(get("recordMaxMinutes"), 1.0, 1440.0, d.record_max_minutes),
        record_max_mb: int(get("recordMaxMb"), 64.0, 16_384.0, d.record_max_mb),
        notify_on_complete: boolean(get("notifyOnComplete"), d.notify_on_complete),
        notify_on_error: boolean(get("notifyOnError"), d.notify_on_error),
    }
}

/// "Look inside players" became on by default (VDH-049); installs that had it off get it on once.
pub const HOOK_DEFAULT_ON: &str = "hookDefaultOn";

/// The stored settings after the hook-default migration: switched on once, then never touched again.
pub fn migrate_hook_default(stored: &Value, applied: &[String]) -> Option<Value> {
    if applied.iter().any(|a| a == HOOK_DEFAULT_ON) {
        return None;
    }
    let mut obj = stored.as_object()?.clone();
    obj.insert("pageHook".into(), Value::Bool(true));
    Some(Value::Object(obj))
}

/// Picks the variant to preselect for a quality preset: the best at or below the preset, else the lowest.
pub fn pick_variant_index(heights: &[Option<f64>], preset: &str) -> i64 {
    if heights.is_empty() {
        return -1;
    }
    if preset == "highest" {
        return 0; // variants are sorted best-first
    }
    let cap = js::number(preset);
    heights
        .iter()
        .position(|h| h.is_none_or(|h| h <= cap))
        .map_or(heights.len() as i64 - 1, |i| i as i64)
}
