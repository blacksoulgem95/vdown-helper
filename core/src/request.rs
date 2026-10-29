//! Requests (`src/lib/request.ts`): the user's choices for a resource, the request they become, the plan for it, and the
//! validation of a request received over messaging. Functions that name files take `today` (YYYY-MM-DD): the core has
//! no clock.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::compat::{Limits, Plan, PlanInput, plan_output};
use crate::filetypes::is_file_kind;
use crate::hls::{HlsRendition, HlsVariant};
use crate::js;
use crate::media::{
    codec_families, estimate_bytes, format_from_mime, is_subtitle_file_format, resolution_label,
};
use crate::security::{
    NameTokens, is_safe_fetch_url, render_name_template, sanitize_filename, sanitize_subfolder,
    with_extension,
};
use crate::settings::{Settings, pick_variant_index};
use crate::url::parse_url;

/// The most files one ZIP holds (`src/lib/zip.ts`).
pub const MAX_ZIP_ITEMS: usize = 500;
/// ZIP archives are classic ZIP (not ZIP64): never above 4 GB.
pub const MAX_ZIP_BYTES: f64 = 4000.0 * 1024.0 * 1024.0;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistFacts {
    #[serde(default)]
    pub fragmented: Option<bool>,
    #[serde(default)]
    pub live: Option<bool>,
}

/// The fields of a `MediaResource` (src/types/media.ts) that requests are built from.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaResource {
    pub id: String,
    pub url: String,
    pub tab_id: f64,
    pub page_url: String,
    #[serde(default)]
    pub page_title: String,
    pub host: String,
    pub title: String,
    pub kind: String,
    pub format: String,
    pub media_type: String,
    #[serde(default)]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<f64>,
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    #[serde(default)]
    pub bitrate: Option<f64>,
    #[serde(default)]
    pub codecs: Option<String>,
    #[serde(default)]
    pub variants: Vec<HlsVariant>,
    #[serde(default)]
    pub audio_tracks: Vec<HlsRendition>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub playlist: Option<PlaylistFacts>,
    #[serde(default)]
    pub held: Option<Value>,
}

/// The parts of a `VariantInspection` a request uses.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionFacts {
    #[serde(default)]
    pub duration_sec: Option<f64>,
    #[serde(default)]
    pub fragmented: Option<bool>,
    #[serde(default)]
    pub live: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choices {
    pub mode: String,
    pub container: String,
    pub audio_format: String,
    pub audio_bitrate: f64,
    /// Index into resource.variants (HLS master).
    pub variant_index: i64,
    /// Index into the audio renditions compatible with the chosen variant; -1 = none/muxed.
    pub audio_index: i64,
    /// Subtitles: keep the format found, or convert to SRT.
    pub subtitle_output: String,
    /// User-typed base name (no extension); empty = use the naming template.
    pub filename: String,
    /// Override of the global "ask where to save" setting.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub save_as: Option<bool>,
}

/// `DownloadRequest` (src/types/download.ts). Parts the background owns (`held`, `zip`, `capture`, ...) travel as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub resource_id: String,
    pub source_url: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub audio_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub master_url: Option<String>,
    pub tab_id: f64,
    pub page_url: String,
    pub host: String,
    pub mode: String,
    pub container: String,
    pub audio_format: String,
    pub audio_bitrate: f64,
    pub filename: String,
    pub subfolder: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub save_as: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub credentialed_origins: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub replay: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub subtitle: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub held: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub zip: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capture: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub record: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub live_record: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file: Option<Value>,
    pub quality_label: String,
    pub source_format: String,
    pub is_hls: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub is_dash: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub fragmented: Option<bool>,
    pub has_muxed_audio: bool,
    pub has_video: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub live: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub audio_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub estimated_bytes: Option<f64>,
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

fn truthy_num(n: Option<f64>) -> Option<f64> {
    n.filter(|n| *n != 0.0 && !n.is_nan())
}

/// Audio renditions that belong to the chosen variant's audio group (or all, for audio-only masters).
pub fn audio_options<'a>(
    resource: &'a MediaResource,
    variant: Option<&HlsVariant>,
) -> Vec<&'a HlsRendition> {
    match variant {
        None => resource.audio_tracks.iter().collect(),
        Some(v) => match non_empty(v.audio_group.as_deref()) {
            None => Vec::new(),
            Some(g) => resource
                .audio_tracks
                .iter()
                .filter(|a| a.group_id == g)
                .collect(),
        },
    }
}

fn is_segmented(r: &MediaResource) -> bool {
    matches!(r.kind.as_str(), "hls-master" | "hls-media" | "dash")
}

fn variant_at(r: &MediaResource, index: i64) -> Option<&HlsVariant> {
    usize::try_from(index).ok().and_then(|i| r.variants.get(i))
}

pub fn default_choices(resource: &MediaResource, settings: &Settings) -> Choices {
    let heights: Vec<Option<f64>> = resource.variants.iter().map(|v| v.height).collect();
    let variant_index = pick_variant_index(&heights, &settings.preferred_quality);
    let opts = audio_options(resource, variant_at(resource, variant_index));
    let def = opts
        .iter()
        .position(|a| a.is_default)
        .map_or(-1, |i| i as i64);
    let mut mode = settings.default_mode.clone();
    if resource.media_type == "audio" && (mode == "video-audio" || mode == "video-only") {
        mode = "original".into();
    }
    // Only a segmented stream gets the user's container (MP4 by default): a plain file is saved as it is, and
    // "Original quality" means the source as it is.
    let container = if mode != "original" && is_segmented(resource) {
        settings.default_container.clone()
    } else {
        "original".into()
    };
    Choices {
        mode,
        container,
        audio_format: settings.default_audio_format.clone(),
        audio_bitrate: settings.default_audio_bitrate,
        variant_index: variant_index.max(0),
        audio_index: if opts.is_empty() { -1 } else { def.max(0) },
        subtitle_output: default_subtitle_output(resource).into(),
        filename: String::new(),
        save_as: None,
    }
}

fn limits_of(settings: &Settings) -> Limits {
    Limits {
        max_memory_mb: settings.max_memory_mb,
        max_encode_duration_sec: settings.max_encode_duration_sec,
    }
}

/// The choices, or the same with the original container when the preferred one cannot work for this stream.
pub fn workable_choices(
    resource: &MediaResource,
    settings: &Settings,
    choices: &Choices,
    inspection: Option<&InspectionFacts>,
    today: &str,
) -> Choices {
    if choices.container == "original" {
        return choices.clone();
    }
    // A stream of fragmented MP4 is saved as .mp4 already: re-packaging it would only cost memory.
    if choices.container == "mp4" && inspection.is_some_and(|i| i.fragmented == Some(true)) {
        return Choices {
            container: "original".into(),
            ..choices.clone()
        };
    }
    let limits = limits_of(settings);
    if plan_from_request(
        &build_request(resource, settings, choices, inspection, today),
        limits,
    )
    .valid
    {
        return choices.clone();
    }
    let kept = Choices {
        container: "original".into(),
        ..choices.clone()
    };
    if plan_from_request(
        &build_request(resource, settings, &kept, inspection, today),
        limits,
    )
    .valid
    {
        kept
    } else {
        choices.clone()
    }
}

/// Keep the original unless the format is not one we can name (then a converted SRT is the only honest result).
pub fn default_subtitle_output(resource: &MediaResource) -> &'static str {
    if resource.kind == "subtitle" && !is_known_subtitle_format(&resource.format) {
        "srt"
    } else {
        "original"
    }
}

fn is_known_subtitle_format(format: &str) -> bool {
    is_subtitle_file_format(format) || format == "hls" || format == "dash"
}

/// The extension of the file a subtitle request produces.
fn subtitle_extension(format: &str, output: &str) -> String {
    if output == "srt" {
        return "srt".into();
    }
    // stitched streams are written as WebVTT
    if is_subtitle_file_format(format) {
        format.into()
    } else {
        "vtt".into()
    }
}

/// A ZIP of several plain files. The request only names the resources; the background derives the URLs and entry names.
pub fn build_zip_request(
    resources: &[MediaResource],
    settings: &Settings,
) -> Option<DownloadRequest> {
    let first = resources.first()?;
    let known: f64 = resources
        .iter()
        .map(|r| {
            if r.held.is_some() {
                0.0
            } else {
                r.size_bytes.unwrap_or(0.0)
            }
        })
        .sum();
    let name = if first.page_title.is_empty() {
        &first.host
    } else {
        &first.page_title
    };
    let title = sanitize_filename(name, "files", 100);
    let n = resources.len();
    let ids: Vec<Value> = resources
        .iter()
        .take(MAX_ZIP_ITEMS)
        .map(|r| Value::String(r.id.clone()))
        .collect();
    Some(DownloadRequest {
        resource_id: first.id.clone(),
        // Only a label for the queue and a safe URL for validation: the files come from `zip.items`.
        source_url: first.page_url.clone(),
        tab_id: first.tab_id,
        page_url: first.page_url.clone(),
        host: first.host.clone(),
        mode: "original".into(),
        container: "original".into(),
        audio_format: settings.default_audio_format.clone(),
        audio_bitrate: settings.default_audio_bitrate,
        filename: with_extension(&format!("{title} ({n} files)"), "zip"),
        subfolder: sanitize_subfolder(&settings.subfolder),
        save_as: Some(settings.ask_where_to_save),
        quality_label: format!("ZIP · {n}"),
        source_format: "unknown".into(),
        zip: Some(serde_json::json!({ "resourceIds": ids })),
        estimated_bytes: (known > 0.0).then_some(known),
        ..DownloadRequest::default()
    })
}

fn base_request(
    resource: &MediaResource,
    settings: &Settings,
    choices: &Choices,
) -> DownloadRequest {
    DownloadRequest {
        resource_id: resource.id.clone(),
        source_url: resource.url.clone(),
        tab_id: resource.tab_id,
        page_url: resource.page_url.clone(),
        host: resource.host.clone(),
        mode: "original".into(),
        container: "original".into(),
        audio_format: choices.audio_format.clone(),
        audio_bitrate: choices.audio_bitrate,
        subfolder: sanitize_subfolder(&settings.subfolder),
        save_as: Some(choices.save_as.unwrap_or(settings.ask_where_to_save)),
        source_format: "unknown".into(),
        ..DownloadRequest::default()
    }
}

/// Images, documents, archives and page assets: saved as they are, under the name the server gives them.
fn build_plain_file_request(
    resource: &MediaResource,
    settings: &Settings,
    choices: &Choices,
) -> DownloadRequest {
    let ext = resource.ext.clone().unwrap_or_default();
    let typed = js::trim(&choices.filename);
    let base = sanitize_filename(
        if typed.is_empty() {
            &resource.title
        } else {
            typed
        },
        "file",
        150,
    );
    DownloadRequest {
        filename: if ext.is_empty() {
            base
        } else {
            with_extension(&base, &ext)
        },
        quality_label: ext.to_uppercase(),
        file: Some(serde_json::json!({ "kind": resource.kind })),
        held: resource.held.clone(),
        estimated_bytes: resource.size_bytes,
        ..base_request(resource, settings, choices)
    }
}

fn build_subtitle_request(
    resource: &MediaResource,
    settings: &Settings,
    choices: &Choices,
    today: &str,
) -> DownloadRequest {
    let output = if is_known_subtitle_format(&resource.format) {
        choices.subtitle_output.as_str()
    } else {
        "srt"
    };
    let ext = subtitle_extension(&resource.format, output);
    let lang = non_empty(resource.language.as_deref())
        .map(|l| sanitize_filename(l, "video", 150))
        .unwrap_or_default();
    let typed = js::trim(&choices.filename);
    let base = if !typed.is_empty() {
        sanitize_filename(&choices.filename, "video", 150)
    } else {
        let title =
            if !lang.is_empty() && !resource.title.to_lowercase().contains(&lang.to_lowercase()) {
                format!("{}.{lang}", resource.title)
            } else {
                resource.title.clone()
            };
        render_name_template(
            &settings.naming_template,
            &NameTokens {
                title,
                host: resource.host.clone(),
                resolution: String::new(),
                date: today.into(),
                format: ext.clone(),
                id: resource.id.clone(),
            },
        )
    };
    DownloadRequest {
        filename: with_extension(&base, &ext),
        quality_label: if output == "srt" {
            "SRT".into()
        } else {
            ext.to_uppercase()
        },
        source_format: resource.format.clone(),
        is_hls: resource.format == "hls",
        is_dash: (resource.format == "dash").then_some(true),
        subtitle: Some(serde_json::json!({ "output": output })),
        duration_sec: truthy_num(resource.duration_sec),
        ..base_request(resource, settings, choices)
    }
}

/// Assemble a request from a resource and the user's choices.
pub fn build_request(
    resource: &MediaResource,
    settings: &Settings,
    choices: &Choices,
    inspection: Option<&InspectionFacts>,
    today: &str,
) -> DownloadRequest {
    if resource.kind == "subtitle" {
        return build_subtitle_request(resource, settings, choices, today);
    }
    if is_file_kind(&resource.kind) {
        return build_plain_file_request(resource, settings, choices);
    }
    let is_master = resource.kind == "hls-master" || resource.kind == "dash";
    let is_dash = resource.kind == "dash";
    let variant = if is_master {
        variant_at(resource, choices.variant_index)
    } else {
        None
    };
    let audio_opts = audio_options(resource, variant);
    let audio_track = usize::try_from(choices.audio_index)
        .ok()
        .and_then(|i| audio_opts.get(i).copied());
    let audio_only_master = is_master && resource.variants.is_empty();
    let is_hls = resource.kind == "hls-master" || resource.kind == "hls-media";

    let mut source_url = resource.url.clone();
    let mut audio_url: Option<String> = None;
    let mut codecs = resource.codecs.clone();
    let mut height = resource.height;
    let mut bandwidth = resource.bitrate;
    if let Some(v) = variant {
        source_url = v.uri.clone();
        codecs = v.codecs.clone();
        height = v.height;
        bandwidth = Some(v.average_bandwidth.unwrap_or(v.bandwidth));
        audio_url = audio_track
            .and_then(|t| non_empty(t.uri.as_deref()))
            .map(str::to_string);
    } else if audio_only_master {
        source_url = audio_track
            .and_then(|t| t.uri.clone())
            .or_else(|| audio_opts.first().and_then(|t| t.uri.clone()))
            .unwrap_or_else(|| resource.url.clone());
    }
    if choices.mode == "audio-only" && is_master {
        if let Some(a) = audio_url.take() {
            // Fetch only the audio rendition instead of the whole video.
            source_url = a;
            // The track's own codec when the manifest states it (DASH); unknown (never assumed) otherwise.
            codecs = match audio_track {
                Some(t) => t.codecs.clone(),
                None => codecs,
            };
        } else if variant.is_some() {
            // Audio is muxed into the video stream: use the lightest variant that carries audio.
            let mut candidates: Vec<&HlsVariant> = resource
                .variants
                .iter()
                .filter(|v| {
                    non_empty(v.audio_group.as_deref()).is_none()
                        && (non_empty(v.codecs.as_deref()).is_none()
                            || codec_families(v.codecs.as_deref()).audio.is_some())
                })
                .collect();
            candidates.sort_by(|a, b| {
                a.bandwidth
                    .partial_cmp(&b.bandwidth)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            if let Some(l) = candidates.first() {
                source_url = l.uri.clone();
                codecs = l.codecs.clone();
                bandwidth = Some(l.average_bandwidth.unwrap_or(l.bandwidth));
            }
        }
    }
    if choices.mode == "video-only" {
        audio_url = None;
    }
    let fam = codec_families(codecs.as_deref());
    let separate_audio = audio_url.is_some();
    let has_video = !audio_only_master && resource.media_type != "audio";
    let audio_codec_known_missing = codecs.is_some() && fam.audio.is_none() && fam.video.is_some();
    let audio_from_rendition = choices.mode == "audio-only"
        && source_url != resource.url
        && audio_track
            .is_some_and(|t| non_empty(t.uri.as_deref()).is_some_and(|u| u == source_url));
    let has_muxed_audio = if audio_only_master || audio_from_rendition {
        true
    } else if separate_audio {
        false
    } else {
        !audio_codec_known_missing
    };

    let duration = inspection
        .and_then(|i| i.duration_sec)
        .or(resource.duration_sec);
    let estimated = if is_hls || is_dash {
        estimate_bytes(bandwidth, duration)
    } else {
        resource.size_bytes
    };
    let source_format = if is_hls {
        "hls".to_string()
    } else if is_dash {
        "dash".to_string()
    } else if resource.format != "unknown" {
        resource.format.clone()
    } else {
        format_from_mime(resource.mime_type.as_deref())
            .unwrap_or("unknown")
            .to_string()
    };
    let mut req = DownloadRequest {
        resource_id: resource.id.clone(),
        source_url,
        tab_id: resource.tab_id,
        page_url: resource.page_url.clone(),
        host: resource.host.clone(),
        mode: choices.mode.clone(),
        container: choices.container.clone(),
        audio_format: choices.audio_format.clone(),
        audio_bitrate: choices.audio_bitrate,
        subfolder: sanitize_subfolder(&settings.subfolder),
        save_as: Some(choices.save_as.unwrap_or(settings.ask_where_to_save)),
        source_format,
        is_hls,
        has_muxed_audio,
        has_video,
        audio_url: audio_url.filter(|a| !a.is_empty()),
        held: resource.held.clone(),
        ..DownloadRequest::default()
    };
    if is_dash {
        req.is_dash = Some(true);
        req.fragmented = Some(true); // DASH segments are fragmented MP4
    }
    if is_master {
        req.master_url = Some(resource.url.clone());
    }
    if let Some(i) = inspection {
        req.fragmented = i.fragmented;
        req.live = i.live;
    } else if let Some(p) = &resource.playlist {
        if p.fragmented.is_some() {
            req.fragmented = p.fragmented;
        }
        if p.live.is_some() {
            req.live = p.live;
        }
    }
    req.video_codec = fam.video.map(str::to_string);
    // A separate audio track carries its own codec when the manifest says so.
    let track_audio = if separate_audio {
        audio_track
            .and_then(|t| non_empty(t.codecs.as_deref()))
            .and_then(|c| codec_families(Some(c)).audio)
    } else {
        None
    };
    req.audio_codec = fam.audio.or(track_audio).map(str::to_string);
    req.duration_sec = truthy_num(duration);
    req.estimated_bytes = estimated;

    let plan = plan_from_request(&req, limits_of(settings));
    // May be empty for a source of unknown type: the file then keeps no extension and Chrome picks one.
    let ext = plan.extension;
    let typed = js::trim(&choices.filename);
    let base = if !typed.is_empty() {
        sanitize_filename(&choices.filename, "video", 150)
    } else {
        render_name_template(
            &settings.naming_template,
            &NameTokens {
                title: resource.title.clone(),
                host: resource.host.clone(),
                resolution: if choices.mode == "audio-only" {
                    String::new()
                } else {
                    resolution_label(height, None)
                },
                date: today.into(),
                format: ext.clone(),
                id: resource.id.clone(),
            },
        )
    };
    req.filename = if ext.is_empty() {
        base
    } else {
        with_extension(&base, &ext)
    };
    req.quality_label = quality_label_for(&req.mode, &req.audio_format, &req.source_format, height);
    req
}

pub fn quality_label_for(
    mode: &str,
    audio_format: &str,
    source_format: &str,
    height: Option<f64>,
) -> String {
    if mode == "audio-only" {
        return audio_format.to_uppercase();
    }
    let res = resolution_label(height, None);
    if res.is_empty() {
        source_format.to_uppercase()
    } else {
        res
    }
}

fn present(v: &Option<Value>) -> bool {
    v.as_ref().is_some_and(js_truthy)
}

/// JavaScript truthiness of a JSON value.
pub fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Single source of truth for "what will happen and is it allowed", used by both the UI and the background.
pub fn plan_from_request(req: &DownloadRequest, limits: Limits) -> Plan {
    if present(&req.subtitle) {
        return plan_subtitle(req);
    }
    if present(&req.file) {
        return plan_plain_file(req);
    }
    if present(&req.zip) {
        return plan_zip_job(req, limits);
    }
    if present(&req.capture) {
        return fixed_plan("capture", true, "copy", "copy", "mp4");
    }
    if present(&req.record) {
        let prefer = req
            .record
            .as_ref()
            .and_then(|r| r.get("prefer"))
            .and_then(Value::as_str)
            .unwrap_or("webm");
        let prefer = if prefer.is_empty() { "webm" } else { prefer };
        return fixed_plan(
            "record",
            true,
            if req.has_video { "copy" } else { "none" },
            "copy",
            prefer,
        );
    }
    if req.live_record == Some(true) {
        return plan_live(req);
    }
    let input = PlanInput {
        is_hls: req.is_hls || req.is_dash == Some(true), // a segmented stream (HLS or DASH)
        source_format: if req.is_dash == Some(true) {
            "hls".into()
        } else {
            req.source_format.clone()
        },
        has_muxed_audio: req.has_muxed_audio,
        separate_audio: req.audio_url.is_some(),
        has_video: req.has_video,
        mode: req.mode.clone(),
        container: req.container.clone(),
        audio_format: req.audio_format.clone(),
        audio_bitrate: req.audio_bitrate,
        limits,
        fragmented: req.fragmented,
        video_family: non_empty(req.video_codec.as_deref()).map(str::to_string),
        audio_family: non_empty(req.audio_codec.as_deref()).map(str::to_string),
        estimated_bytes: req.estimated_bytes,
        duration_sec: req.duration_sec,
        live: req.live,
        protected_stream: None,
    };
    plan_output(&input)
}

fn fixed_plan(pipeline: &str, ffmpeg: bool, video: &str, audio: &str, ext: &str) -> Plan {
    Plan {
        valid: true,
        requires_ffmpeg: ffmpeg,
        ..Plan::new(pipeline, video, audio, ext)
    }
}

/// A live or event stream (HLS, DASH dynamic) recorded by the extension itself.
fn plan_live(req: &DownloadRequest) -> Plan {
    let mut issues = Vec::new();
    if !req.is_hls && req.is_dash != Some(true) {
        issues.push("unsupported-source".to_string());
    }
    let (video, ext) = if req.has_video {
        ("copy", "mp4")
    } else {
        ("none", "m4a")
    };
    Plan {
        valid: issues.is_empty(),
        issues,
        requires_ffmpeg: true,
        ..Plan::new("live", video, "copy", ext)
    }
}

/// A recording request for a live stream the scan found, with the quality the user's settings prefer.
pub fn build_live_request(
    resource: &MediaResource,
    settings: &Settings,
    today: &str,
) -> DownloadRequest {
    let choices = default_choices(resource, settings);
    let req = build_request(
        resource,
        settings,
        &Choices {
            mode: (if resource.media_type == "audio" {
                "original"
            } else {
                "video-audio"
            })
            .into(),
            container: "original".into(),
            ..choices
        },
        None,
        today,
    );
    let ext = if req.has_video { "mp4" } else { "m4a" };
    let base = if req.filename.is_empty() {
        resource.title.clone()
    } else {
        strip_short_extension(&req.filename)
    };
    DownloadRequest {
        filename: with_extension(
            if base.is_empty() {
                &resource.title
            } else {
                &base
            },
            ext,
        ),
        quality_label: "LIVE".into(),
        live: Some(true),
        live_record: Some(true),
        ..req
    }
}

/// `name.replace(/\.[a-z0-9]{1,5}$/i, '')`.
fn strip_short_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(d)
            if (1..=5).contains(&name[d + 1..].len())
                && name[d + 1..].bytes().all(|b| b.is_ascii_alphanumeric()) =>
        {
            name[..d].to_string()
        }
        _ => name.to_string(),
    }
}

/// A recording request for a MediaStream the scan found (`held.kind === 'stream'`).
pub fn build_record_request(
    resource: &MediaResource,
    settings: &Settings,
    today: &str,
) -> DownloadRequest {
    let has_video = resource.media_type != "audio";
    let prefer = settings.record_container.clone();
    let base = render_name_template(
        &settings.naming_template,
        &NameTokens {
            title: resource.title.clone(),
            host: resource.host.clone(),
            resolution: if has_video {
                resolution_label(resource.height, None)
            } else {
                String::new()
            },
            date: today.into(),
            format: prefer.clone(),
            id: resource.id.clone(),
        },
    );
    DownloadRequest {
        audio_format: settings.default_audio_format.clone(),
        audio_bitrate: settings.default_audio_bitrate,
        filename: with_extension(&base, &prefer),
        save_as: Some(settings.ask_where_to_save),
        quality_label: "RECORD".into(),
        has_muxed_audio: true,
        has_video,
        record: Some(serde_json::json!({ "prefer": prefer })),
        held: resource.held.clone(),
        ..base_request_plain(resource, settings)
    }
}

fn base_request_plain(resource: &MediaResource, settings: &Settings) -> DownloadRequest {
    DownloadRequest {
        resource_id: resource.id.clone(),
        source_url: resource.url.clone(),
        tab_id: resource.tab_id,
        page_url: resource.page_url.clone(),
        host: resource.host.clone(),
        mode: "original".into(),
        container: "original".into(),
        subfolder: sanitize_subfolder(&settings.subfolder),
        source_format: "unknown".into(),
        ..DownloadRequest::default()
    }
}

/// A capture request for a MediaSource player the scan found (`held.kind === 'mse'`).
pub fn build_capture_request(
    resource: &MediaResource,
    settings: &Settings,
    speed: &str,
    today: &str,
) -> DownloadRequest {
    let base = render_name_template(
        &settings.naming_template,
        &NameTokens {
            title: resource.title.clone(),
            host: resource.host.clone(),
            resolution: resolution_label(resource.height, None),
            date: today.into(),
            format: "mp4".into(),
            id: resource.id.clone(),
        },
    );
    DownloadRequest {
        audio_format: settings.default_audio_format.clone(),
        audio_bitrate: settings.default_audio_bitrate,
        // the extension is decided from the codecs once the capture is done
        filename: with_extension(&base, "mp4"),
        save_as: Some(settings.ask_where_to_save),
        quality_label: (if speed == "fast" { "CAPTURE" } else { "RECORD" }).into(),
        has_muxed_audio: true,
        has_video: true,
        capture: Some(serde_json::json!({ "speed": speed })),
        held: resource.held.clone(),
        duration_sec: truthy_num(resource.duration_sec),
        ..base_request_plain(resource, settings)
    }
}

pub fn zip_limit_bytes(max_memory_mb: f64) -> f64 {
    (max_memory_mb * 1024.0 * 1024.0).min(MAX_ZIP_BYTES)
}

fn plan_zip_job(req: &DownloadRequest, limits: Limits) -> Plan {
    let mut issues = Vec::new();
    if req
        .estimated_bytes
        .is_some_and(|b| b > zip_limit_bytes(limits.max_memory_mb))
    {
        issues.push("too-large".to_string());
    }
    Plan {
        valid: issues.is_empty(),
        issues,
        ..Plan::new("zip", "none", "none", "zip")
    }
}

/// A plain file is Chrome's own download, as is.
fn plan_plain_file(req: &DownloadRequest) -> Plan {
    let ext = match req.filename.rfind('.') {
        Some(d) if d > 0 => req.filename[d + 1..].to_string(),
        _ => String::new(),
    };
    Plan {
        valid: true,
        ..Plan::new("native", "none", "none", &ext)
    }
}

/// Subtitles are small text: no FFmpeg, no size limit. A plain document saved as found is a native download.
fn plan_subtitle(req: &DownloadRequest) -> Plan {
    let segmented = req.is_hls || req.is_dash == Some(true);
    let output = req
        .subtitle
        .as_ref()
        .and_then(|s| s.get("output"))
        .and_then(Value::as_str)
        .unwrap_or("original")
        .to_string();
    let mut issues = Vec::new();
    if req.live == Some(true) {
        issues.push("live-stream".to_string());
    }
    let pipeline = if !segmented && output == "original" {
        "native"
    } else {
        "subtitle"
    };
    Plan {
        valid: issues.is_empty(),
        issues,
        ..Plan::new(
            pipeline,
            "none",
            "none",
            &subtitle_extension(&req.source_format, &output),
        )
    }
}

/// `data:<mime>;vdh=<8 hex>`: a label for bytes the page holds (`src/lib/dataUrl.ts`).
pub fn is_data_label(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("data:") else {
        return false;
    };
    let Some((mime, handle)) = rest.split_once(";vdh=") else {
        return false;
    };
    (3..=170).contains(&mime.len())
        && mime
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$&^_.+/-".contains(&b))
        && handle.len() == 8
        && handle
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Normalise a request received over messaging: never trust the sender's filename, folder or URLs. `None` when a URL
/// is unsafe or the request is not shaped like one. Works on the JSON object, so fields it does not touch pass through.
pub fn sanitize_request(req: &Value) -> Option<Value> {
    // A JavaScript `undefined` property arrives as null: treat it as absent, as the TypeScript did.
    let r: Map<String, Value> = req
        .as_object()?
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let r = &r;
    let truthy = |k: &str| r.get(k).is_some_and(js_truthy);
    let source_url = r.get("sourceUrl")?.as_str()?;
    let audio_url = r.get("audioUrl");
    // A page-held source (data: URL) is only a label here; the background matches it to its own scan.
    if is_data_label(source_url) {
        if audio_url.is_some() || truthy("isHls") || r.get("isDash") == Some(&Value::Bool(true)) {
            return None;
        }
    } else if !is_safe_fetch_url(source_url) {
        return None;
    }
    if let Some(a) = audio_url {
        if !a.as_str().is_some_and(is_safe_fetch_url) {
            return None;
        }
    }
    let filename = r.get("filename")?.as_str()?;
    let (stem, ext) = match filename.rfind('.') {
        Some(d) if d > 0 => {
            let ext: String = filename[d + 1..]
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .take(5)
                .collect();
            (&filename[..d], ext.to_lowercase())
        }
        _ => (filename, String::new()),
    };
    let base = sanitize_filename(stem, "video", 150);
    // Cookies may only accompany requests to the page's own origin (never an origin the page merely names).
    let page_origin = r
        .get("pageUrl")
        .and_then(Value::as_str)
        .and_then(|p| parse_url(p, None))
        .map(|u| u.origin().ascii_serialization());
    let origins: Vec<Value> = r
        .get("credentialedOrigins")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|o| Some(*o) == page_origin.as_deref() && is_bare_origin(o))
                .map(|o| Value::String(o.into()))
                .collect()
        })
        .unwrap_or_default();
    let segmented = truthy("isHls") || r.get("isDash") == Some(&Value::Bool(true));
    let mut out: Map<String, Value> = r.clone();
    out.insert(
        "filename".into(),
        Value::String(if ext.is_empty() {
            base
        } else {
            format!("{base}.{ext}")
        }),
    );
    let subfolder = r.get("subfolder").and_then(Value::as_str)?;
    out.insert(
        "subfolder".into(),
        Value::String(sanitize_subfolder(subfolder)),
    );
    out.insert("credentialedOrigins".into(), Value::Array(origins));
    // Only the background may decide which frame's headers a job replays, and what the page holds.
    out.remove("replay");
    out.remove("held");
    let pick = |k: &str, field: &str, allowed: &[&str]| -> Option<Value> {
        let v = r.get(k).filter(|v| js_truthy(v))?.get(field)?.as_str()?;
        allowed
            .contains(&v)
            .then(|| serde_json::json!({ field: v }))
    };
    set_or_remove(
        &mut out,
        "capture",
        pick("capture", "speed", &["fast", "realtime"]),
    );
    set_or_remove(
        &mut out,
        "liveRecord",
        (r.get("liveRecord") == Some(&Value::Bool(true)) && segmented).then_some(Value::Bool(true)),
    );
    set_or_remove(
        &mut out,
        "record",
        pick("record", "prefer", &["webm", "mp4"]),
    );
    // The names and URLs inside a ZIP are the background's to decide.
    set_or_remove(&mut out, "zip", sanitize_zip(r.get("zip")));
    let file = r
        .get("file")
        .filter(|f| js_truthy(f))
        .and_then(|f| f.get("kind"))
        .and_then(Value::as_str)
        .filter(|k| is_file_kind(k))
        .map(|k| serde_json::json!({ "kind": k }));
    set_or_remove(&mut out, "file", file);
    Some(Value::Object(out))
}

fn set_or_remove(out: &mut Map<String, Value>, key: &str, v: Option<Value>) {
    match v {
        Some(v) => {
            out.insert(key.into(), v);
        }
        None => {
            out.remove(key);
        }
    }
}

/// `/^https?:\/\/[^/]+$/`.
fn is_bare_origin(o: &str) -> bool {
    let rest = o
        .strip_prefix("https://")
        .or_else(|| o.strip_prefix("http://"));
    rest.is_some_and(|h| !h.is_empty() && !h.contains('/'))
}

fn sanitize_zip(zip: Option<&Value>) -> Option<Value> {
    let ids = zip
        .filter(|z| js_truthy(z))?
        .get("resourceIds")?
        .as_array()?;
    let ids: Vec<Value> = ids
        .iter()
        .filter(|x| x.as_str().is_some_and(|s| js::len_utf16(s) <= 64))
        .take(MAX_ZIP_ITEMS)
        .cloned()
        .collect();
    (!ids.is_empty()).then(|| serde_json::json!({ "resourceIds": ids }))
}
