//! The extension's door into `vdh-core`: each export takes and returns plain JavaScript values shaped exactly like the
//! TypeScript types in `src/types` (objects, not `Map`s; absent optional fields are left out; `None` is `undefined`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use vdh_core::{analyze, dash, hls, inspect, xml};
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(value: &T) -> JsValue {
    // json_compatible: maps become plain objects and u64 become numbers, like JSON.parse would give.
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        // Serialising plain data cannot fail; undefined is the safest answer if it ever did.
        .unwrap_or(JsValue::UNDEFINED)
}

fn opt_to_js<T: Serialize>(value: Option<T>) -> JsValue {
    value.map_or(JsValue::UNDEFINED, |v| to_js(&v))
}

fn from_js<T: DeserializeOwned>(value: JsValue, what: &str) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(value).map_err(|e| JsError::new(&format!("invalid {what}: {e}")))
}

#[wasm_bindgen(js_name = parseHls)]
pub fn parse_hls(text: &str, url: &str) -> JsValue {
    to_js(&hls::parse_hls(text, url))
}

#[wasm_bindgen(js_name = classifyPlaylist)]
pub fn classify_playlist(text: &str) -> JsValue {
    to_js(&hls::classify_playlist(text))
}

#[wasm_bindgen(js_name = parseAttributes)]
pub fn parse_attributes(input: &str) -> JsValue {
    to_js(&hls::attributes::parse_attributes(input))
}

#[wasm_bindgen(js_name = parseXml)]
pub fn parse_xml(input: &str, max_nodes: Option<u32>, max_depth: Option<u32>) -> JsValue {
    let mut limits = xml::XmlLimits::default();
    if let Some(n) = max_nodes {
        limits.max_nodes = n as usize;
    }
    if let Some(d) = max_depth {
        limits.max_depth = d as usize;
    }
    opt_to_js(xml::parse_xml(input, limits))
}

#[wasm_bindgen(js_name = decodeEntities)]
pub fn decode_entities(s: &str) -> String {
    xml::decode_entities(s)
}

#[wasm_bindgen(js_name = parseDash)]
pub fn parse_dash(text: &str, url: &str) -> JsValue {
    to_js(&dash::parse_dash(text, url))
}

#[wasm_bindgen(js_name = parseIsoDuration)]
pub fn parse_iso_duration(value: Option<String>) -> Option<f64> {
    dash::parse_iso_duration(value.as_deref())
}

#[wasm_bindgen(js_name = mainPeriodIndex)]
pub fn main_period_index(manifest: JsValue) -> Result<usize, JsError> {
    Ok(dash::main_period_index(&from_js(manifest, "manifest")?))
}

#[wasm_bindgen(js_name = periodDuration)]
pub fn period_duration(manifest: JsValue, period: JsValue) -> Result<Option<f64>, JsError> {
    Ok(dash::period_duration(
        &from_js(manifest, "manifest")?,
        &from_js(period, "period")?,
    ))
}

#[derive(Deserialize)]
#[serde(untagged)]
enum VarIn {
    Str(String),
    Num(f64),
}

#[wasm_bindgen]
pub fn substitute(template: &str, vars: JsValue) -> Result<String, JsError> {
    let vars: HashMap<String, VarIn> = from_js(vars, "variables")?;
    let vars: HashMap<&str, dash::Var> = vars
        .iter()
        .map(|(k, v)| {
            let var = match v {
                VarIn::Str(s) => dash::Var::Str(s.clone()),
                VarIn::Num(n) => dash::Var::Num(*n),
            };
            (k.as_str(), var)
        })
        .collect();
    Ok(dash::substitute(template, &vars))
}

/// `{ ok: true, value } | { ok: false, error }`: the TypeScript wrapper throws `DashExpandError` on `ok: false`.
#[wasm_bindgen(js_name = expandSegments)]
pub fn expand_segments(
    manifest: JsValue,
    period: JsValue,
    rep: JsValue,
    now_ms: f64,
) -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    #[serde(untagged)]
    enum Out {
        Ok {
            ok: bool,
            value: dash::ExpandedRepresentation,
        },
        Err {
            ok: bool,
            error: String,
        },
    }
    let r = dash::expand_segments(
        &from_js(manifest, "manifest")?,
        &from_js(period, "period")?,
        &from_js(rep, "representation")?,
        now_ms,
    );
    Ok(to_js(&match r {
        Ok(value) => Out::Ok { ok: true, value },
        Err(error) => Out::Err { ok: false, error },
    }))
}

#[wasm_bindgen(js_name = protectionsOf)]
pub fn protections_of(reps: JsValue) -> Result<JsValue, JsError> {
    let reps: Vec<dash::DashRepresentation> = from_js(reps, "representations")?;
    Ok(to_js(&dash::protections_of(&reps)))
}

#[wasm_bindgen(js_name = dashRef)]
pub fn dash_ref(manifest_url: &str, rep_id: &str) -> String {
    dash::dash_ref(manifest_url, rep_id)
}

#[wasm_bindgen(js_name = parseDashRef)]
pub fn parse_dash_ref(url: &str) -> JsValue {
    opt_to_js(dash::parse_dash_ref(url))
}

#[wasm_bindgen(js_name = mediaPlaylistVerdict)]
pub fn media_playlist_verdict(playlist: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&analyze::media_playlist_verdict(&from_js(
        playlist,
        "media playlist",
    )?)))
}

#[wasm_bindgen(js_name = dashResource)]
pub fn dash_resource(text: &str, url: &str) -> JsValue {
    to_js(&analyze::dash_resource(text, url))
}

#[wasm_bindgen(js_name = inspectMediaPlaylist)]
pub fn inspect_media_playlist(playlist: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&inspect::inspect_media_playlist(&from_js(
        playlist,
        "media playlist",
    )?)))
}

/// `{ ok: true, value } | { ok: false, error }`, like `expandSegments`.
#[wasm_bindgen(js_name = inspectDashRepresentation)]
pub fn inspect_dash_representation(
    manifest: JsValue,
    period: JsValue,
    rep: JsValue,
    now_ms: f64,
) -> Result<JsValue, JsError> {
    #[derive(Serialize)]
    #[serde(untagged)]
    enum Out {
        Ok {
            ok: bool,
            value: inspect::VariantInspection,
        },
        Err {
            ok: bool,
            error: String,
        },
    }
    let r = inspect::inspect_dash_representation(
        &from_js(manifest, "manifest")?,
        &from_js(period, "period")?,
        &from_js(rep, "representation")?,
        now_ms,
    );
    Ok(to_js(&match r {
        Ok(value) => Out::Ok { ok: true, value },
        Err(error) => Out::Err { ok: false, error },
    }))
}

fn urls_of(urls: JsValue) -> Result<Vec<String>, JsError> {
    from_js(urls, "URL list")
}

#[wasm_bindgen(js_name = originsOf)]
pub fn origins_of(urls: JsValue, max: usize) -> Result<JsValue, JsError> {
    let urls = urls_of(urls)?;
    Ok(to_js(&inspect::origins_of(
        urls.iter().map(String::as_str),
        max,
    )))
}

#[wasm_bindgen(js_name = sampleByOrigin)]
pub fn sample_by_origin(urls: JsValue, max: usize) -> Result<JsValue, JsError> {
    let urls = urls_of(urls)?;
    Ok(to_js(&inspect::sample_by_origin(
        urls.iter().map(String::as_str),
        max,
    )))
}

// ---- file types and sniffing

#[wasm_bindgen(js_name = fileKindOfExtension)]
pub fn file_kind_of_extension(ext: Option<String>) -> Option<String> {
    vdh_core::filetypes::file_kind_of_extension(ext.as_deref()).map(str::to_string)
}

#[wasm_bindgen(js_name = extensionForMime)]
pub fn extension_for_mime(mime: Option<String>) -> Option<String> {
    vdh_core::filetypes::extension_for_mime(mime.as_deref()).map(str::to_string)
}

#[wasm_bindgen(js_name = fileKindOfMime)]
pub fn file_kind_of_mime(mime: Option<String>) -> Option<String> {
    vdh_core::filetypes::file_kind_of_mime(mime.as_deref()).map(str::to_string)
}

#[wasm_bindgen(js_name = urlExtension)]
pub fn url_extension(url: &str) -> String {
    vdh_core::filetypes::url_extension(url)
}

#[wasm_bindgen(js_name = fileStem)]
pub fn file_stem(url: &str) -> String {
    vdh_core::filetypes::file_stem(url)
}

#[wasm_bindgen(js_name = sniffMime)]
pub fn sniff_mime(bytes: &[u8]) -> Option<String> {
    vdh_core::sniff::sniff_mime(bytes).map(str::to_string)
}

// ---- security

#[wasm_bindgen(js_name = isSafeFetchUrl)]
pub fn is_safe_fetch_url(url: &str) -> bool {
    vdh_core::security::is_safe_fetch_url(url)
}

#[wasm_bindgen(js_name = isBlobUrl)]
pub fn is_blob_url(url: &str) -> bool {
    vdh_core::security::is_blob_url(url)
}

#[wasm_bindgen(js_name = isPrivateHost)]
pub fn is_private_host(host: &str) -> bool {
    vdh_core::security::is_private_host(host)
}

#[wasm_bindgen(js_name = mayExtensionFetch)]
pub fn may_extension_fetch(target: &str, page_url: &str) -> bool {
    vdh_core::security::may_extension_fetch(target, page_url)
}

#[wasm_bindgen(js_name = normalizeUrl)]
pub fn normalize_url(url: &str) -> String {
    vdh_core::security::normalize_url(url)
}

#[wasm_bindgen(js_name = redactUrl)]
pub fn redact_url(url: &str) -> String {
    vdh_core::security::redact_url(url)
}

#[wasm_bindgen(js_name = redactText)]
pub fn redact_text(text: &str) -> String {
    vdh_core::security::redact_text(text)
}

#[wasm_bindgen(js_name = sanitizeFilename)]
pub fn sanitize_filename(name: &str, fallback: &str, max_length: usize) -> String {
    vdh_core::security::sanitize_filename(name, fallback, max_length)
}

#[wasm_bindgen(js_name = sanitizeSubfolder)]
pub fn sanitize_subfolder(path: &str) -> String {
    vdh_core::security::sanitize_subfolder(path)
}

#[wasm_bindgen(js_name = asciiFileName)]
pub fn ascii_file_name(name: &str) -> String {
    vdh_core::security::ascii_file_name(name)
}

#[wasm_bindgen(js_name = withExtension)]
pub fn with_extension(base: &str, ext: &str) -> String {
    vdh_core::security::with_extension(base, ext)
}

#[wasm_bindgen(js_name = renderNameTemplate)]
pub fn render_name_template(template: &str, tokens: JsValue) -> Result<String, JsError> {
    Ok(vdh_core::security::render_name_template(
        template,
        &from_js(tokens, "name tokens")?,
    ))
}

// ---- settings

#[wasm_bindgen(js_name = sanitizeSettings)]
pub fn sanitize_settings(raw: JsValue) -> JsValue {
    let raw: serde_json::Value =
        serde_wasm_bindgen::from_value(raw).unwrap_or(serde_json::Value::Null);
    to_js(&vdh_core::settings::sanitize_settings(&raw))
}

#[wasm_bindgen(js_name = migrateHookDefault)]
pub fn migrate_hook_default(stored: JsValue, applied: Vec<String>) -> JsValue {
    let stored: serde_json::Value =
        serde_wasm_bindgen::from_value(stored).unwrap_or(serde_json::Value::Null);
    opt_to_js(vdh_core::settings::migrate_hook_default(&stored, &applied))
}

#[wasm_bindgen(js_name = pickVariantIndex)]
pub fn pick_variant_index(heights: JsValue, preset: &str) -> Result<f64, JsError> {
    let heights: Vec<Option<f64>> = from_js(heights, "heights")?;
    Ok(vdh_core::settings::pick_variant_index(&heights, preset) as f64)
}

// ---- planner

#[wasm_bindgen(js_name = videoFitsContainer)]
pub fn video_fits_container(family: Option<String>, container: &str) -> bool {
    vdh_core::compat::video_fits_container(family.as_deref(), container)
}

#[wasm_bindgen(js_name = audioFitsContainer)]
pub fn audio_fits_container(family: Option<String>, container: &str) -> bool {
    vdh_core::compat::audio_fits_container(family.as_deref(), container)
}

#[wasm_bindgen(js_name = sourceFitsContainer)]
pub fn source_fits_container(format: &str, container: &str) -> bool {
    vdh_core::compat::source_fits_container(format, container)
}

#[wasm_bindgen(js_name = fileExtension)]
pub fn file_extension(format: &str) -> String {
    vdh_core::compat::file_extension(format)
}

#[wasm_bindgen(js_name = audioExtension)]
pub fn audio_extension(format: &str) -> String {
    vdh_core::compat::audio_extension(format)
}

#[wasm_bindgen(js_name = planOutput)]
pub fn plan_output(input: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&vdh_core::compat::plan_output(&from_js(
        input,
        "plan input",
    )?)))
}

#[wasm_bindgen(js_name = bitrateOptions)]
pub fn bitrate_options(plan: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&vdh_core::compat::bitrate_options(&from_js(
        plan, "plan",
    )?)))
}

#[wasm_bindgen(js_name = buildFfmpegArgs)]
pub fn build_ffmpeg_args(input: JsValue) -> Result<Vec<String>, JsError> {
    Ok(vdh_core::ffmpeg_args::build_ffmpeg_args(&from_js(
        input,
        "ffmpeg input",
    )?))
}

// ---- requests

use vdh_core::request as rq;

fn inspection_of(v: JsValue) -> Result<Option<rq::InspectionFacts>, JsError> {
    if v.is_undefined() || v.is_null() {
        Ok(None)
    } else {
        from_js(v, "inspection").map(Some)
    }
}

#[wasm_bindgen(js_name = audioOptions)]
pub fn audio_options(resource: JsValue, variant: JsValue) -> Result<JsValue, JsError> {
    let r: rq::MediaResource = from_js(resource, "resource")?;
    let v: Option<hls::HlsVariant> = if variant.is_undefined() || variant.is_null() {
        None
    } else {
        Some(from_js(variant, "variant")?)
    };
    Ok(to_js(&rq::audio_options(&r, v.as_ref())))
}

#[wasm_bindgen(js_name = defaultChoices)]
pub fn default_choices(resource: JsValue, settings: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::default_choices(
        &from_js(resource, "resource")?,
        &from_js(settings, "settings")?,
    )))
}

#[wasm_bindgen(js_name = workableChoices)]
pub fn workable_choices(
    resource: JsValue,
    settings: JsValue,
    choices: JsValue,
    inspection: JsValue,
    today: &str,
) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::workable_choices(
        &from_js(resource, "resource")?,
        &from_js(settings, "settings")?,
        &from_js(choices, "choices")?,
        inspection_of(inspection)?.as_ref(),
        today,
    )))
}

#[wasm_bindgen(js_name = defaultSubtitleOutput)]
pub fn default_subtitle_output(resource: JsValue) -> Result<String, JsError> {
    Ok(rq::default_subtitle_output(&from_js(resource, "resource")?).to_string())
}

#[wasm_bindgen(js_name = buildZipRequest)]
pub fn build_zip_request(resources: JsValue, settings: JsValue) -> Result<JsValue, JsError> {
    let list: Vec<rq::MediaResource> = from_js(resources, "resources")?;
    Ok(opt_to_js(rq::build_zip_request(
        &list,
        &from_js(settings, "settings")?,
    )))
}

#[wasm_bindgen(js_name = buildRequest)]
pub fn build_request(
    resource: JsValue,
    settings: JsValue,
    choices: JsValue,
    inspection: JsValue,
    today: &str,
) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::build_request(
        &from_js(resource, "resource")?,
        &from_js(settings, "settings")?,
        &from_js(choices, "choices")?,
        inspection_of(inspection)?.as_ref(),
        today,
    )))
}

#[wasm_bindgen(js_name = qualityLabelFor)]
pub fn quality_label_for(
    mode: &str,
    audio_format: &str,
    source_format: &str,
    height: Option<f64>,
) -> String {
    rq::quality_label_for(mode, audio_format, source_format, height)
}

#[wasm_bindgen(js_name = planFromRequest)]
pub fn plan_from_request(req: JsValue, limits: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::plan_from_request(
        &from_js(req, "request")?,
        from_js(limits, "limits")?,
    )))
}

#[wasm_bindgen(js_name = buildLiveRequest)]
pub fn build_live_request(
    resource: JsValue,
    settings: JsValue,
    today: &str,
) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::build_live_request(
        &from_js(resource, "resource")?,
        &from_js(settings, "settings")?,
        today,
    )))
}

#[wasm_bindgen(js_name = buildRecordRequest)]
pub fn build_record_request(
    resource: JsValue,
    settings: JsValue,
    today: &str,
) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::build_record_request(
        &from_js(resource, "resource")?,
        &from_js(settings, "settings")?,
        today,
    )))
}

#[wasm_bindgen(js_name = buildCaptureRequest)]
pub fn build_capture_request(
    resource: JsValue,
    settings: JsValue,
    speed: &str,
    today: &str,
) -> Result<JsValue, JsError> {
    Ok(to_js(&rq::build_capture_request(
        &from_js(resource, "resource")?,
        &from_js(settings, "settings")?,
        speed,
        today,
    )))
}

#[wasm_bindgen(js_name = zipLimitBytes)]
pub fn zip_limit_bytes(max_memory_mb: f64) -> f64 {
    rq::zip_limit_bytes(max_memory_mb)
}

#[wasm_bindgen(js_name = sanitizeRequest)]
pub fn sanitize_request(req: JsValue) -> JsValue {
    match serde_wasm_bindgen::from_value::<serde_json::Value>(req) {
        Ok(v) => opt_to_js(rq::sanitize_request(&v)),
        Err(_) => JsValue::UNDEFINED,
    }
}
