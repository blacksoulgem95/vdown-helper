//! Types produced by the DASH parser; serialised exactly like `src/types/dash.ts`.

use serde::{Deserialize, Serialize};

use crate::hls::{OkFalse, OkTrue};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DashContent {
    Video,
    Audio,
    Text,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DashProtectionSystem {
    Widevine,
    Playready,
    Fairplay,
    Marlin,
    Clearkey,
    /// `urn:mpeg:dash:mp4protection:2011`: says the media is CENC-encrypted without naming a key system.
    Cenc,
    Other,
}

impl DashProtectionSystem {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Widevine => "widevine",
            Self::Playready => "playready",
            Self::Fairplay => "fairplay",
            Self::Marlin => "marlin",
            Self::Clearkey => "clearkey",
            Self::Cenc => "cenc",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashProtection {
    pub system: DashProtectionSystem,
    pub scheme_id_uri: String,
    /// ClearKey licence URL (`Laurl`), when the manifest gives one.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub license_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default_kid: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DashByteRange {
    pub offset: f64,
    pub length: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashSegmentRef {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub range: Option<DashByteRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashListSegment {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub range: Option<DashByteRange>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_sec: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimelineEntry {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub t: Option<f64>,
    pub d: f64,
    pub r: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DashAddressing {
    #[serde(rename = "template", rename_all = "camelCase")]
    Template {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        initialization: Option<String>,
        media: String,
        start_number: f64,
        timescale: f64,
        /// Constant segment duration in timescale units (no timeline).
        #[serde(skip_serializing_if = "Option::is_none", default)]
        duration: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        timeline: Option<Vec<TimelineEntry>>,
        presentation_time_offset: f64,
    },
    #[serde(rename = "list")]
    List {
        #[serde(skip_serializing_if = "Option::is_none", default)]
        initialization: Option<DashSegmentRef>,
        segments: Vec<DashListSegment>,
        timescale: f64,
    },
    /// One whole file (BaseURL only, or SegmentBase with an index): downloaded as a single resource.
    #[serde(rename = "single")]
    Single { url: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashRepresentation {
    pub id: String,
    pub content: DashContent,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub codecs: Option<String>,
    pub bandwidth: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frame_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub lang: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    pub protections: Vec<DashProtection>,
    /// Absolute base URL the segment URLs are relative to.
    pub base_url: String,
    pub addressing: DashAddressing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashPeriod {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    pub start_sec: f64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_sec: Option<f64>,
    pub representations: Vec<DashRepresentation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DashType {
    Static,
    Dynamic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashManifest {
    pub url: String,
    #[serde(rename = "type")]
    pub kind: DashType,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_sec: Option<f64>,
    /// `availabilityStartTime` of a dynamic manifest, in ms since the epoch.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub availability_start_ms: Option<f64>,
    /// `minimumUpdatePeriod`: how often a dynamic manifest asks to be fetched again.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub minimum_update_sec: Option<f64>,
    /// `timeShiftBufferDepth`: how far back a dynamic manifest keeps segments.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub time_shift_buffer_sec: Option<f64>,
    pub periods: Vec<DashPeriod>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DashErrorCode {
    Malformed,
    NotDash,
    UnsafeUrl,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DashError {
    pub code: DashErrorCode,
    pub message: String,
}

/// `{ ok: true, manifest } | { ok: false, error }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DashParseResult {
    Ok { ok: OkTrue, manifest: DashManifest },
    Err { ok: OkFalse, error: DashError },
}

impl DashParseResult {
    pub fn err(code: DashErrorCode, message: &str) -> Self {
        Self::Err {
            ok: OkFalse,
            error: DashError {
                code,
                message: message.to_string(),
            },
        }
    }
}

/// What a protected manifest declares (`protectionsOf`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashProtections {
    /// At least one non-ClearKey key system (or bare CENC with no key system we can use): refuse.
    pub drm: bool,
    /// Only ClearKey is declared.
    pub clear_key: bool,
    pub systems: Vec<DashProtectionSystem>,
}
