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

// ---- records passed whole (resources, jobs): JavaScript objects as JSON values

/// A JavaScript value as JSON; `undefined` properties arrive as `null`, which the core reads as `undefined`.
fn json_in(v: JsValue) -> serde_json::Value {
    serde_wasm_bindgen::from_value(v).unwrap_or(serde_json::Value::Null)
}

fn json_list(v: JsValue) -> Vec<serde_json::Value> {
    match json_in(v) {
        serde_json::Value::Array(a) => a,
        _ => Vec::new(),
    }
}

/// A JSON result with every `null` property left out (the TypeScript types never hold `null`).
fn json_out<T: Serialize>(value: &T) -> JsValue {
    let mut v = serde_json::to_value(value).unwrap_or(serde_json::Value::Null);
    vdh_core::obj::strip_nulls(&mut v);
    to_js(&v)
}

// ---- media

use vdh_core::media;

#[wasm_bindgen(js_name = formatBytes)]
pub fn format_bytes(bytes: Option<f64>) -> String {
    media::format_bytes(bytes)
}

#[wasm_bindgen(js_name = formatDuration)]
pub fn format_duration(seconds: Option<f64>) -> String {
    media::format_duration(seconds)
}

#[wasm_bindgen(js_name = formatBitrate)]
pub fn format_bitrate(bits_per_second: Option<f64>) -> String {
    media::format_bitrate(bits_per_second)
}

#[wasm_bindgen(js_name = formatSpeed)]
pub fn format_speed(bytes_per_second: Option<f64>) -> String {
    media::format_speed(bytes_per_second)
}

#[wasm_bindgen(js_name = qualityTag)]
pub fn quality_tag(height: Option<f64>) -> String {
    media::quality_tag(height).into()
}

#[wasm_bindgen(js_name = resolutionLabel)]
pub fn resolution_label(height: Option<f64>, width: Option<f64>) -> String {
    media::resolution_label(height, width)
}

#[wasm_bindgen(js_name = formatFromMime)]
pub fn format_from_mime(mime: Option<String>) -> Option<String> {
    media::format_from_mime(mime.as_deref()).map(Into::into)
}

#[wasm_bindgen(js_name = extensionOf)]
pub fn extension_of(url: &str) -> String {
    media::extension_of(url)
}

#[wasm_bindgen(js_name = formatFromUrl)]
pub fn format_from_url(url: &str) -> Option<String> {
    media::format_from_url(url).map(Into::into)
}

#[wasm_bindgen(js_name = mediaTypeOf)]
pub fn media_type_of(format: &str) -> String {
    media::media_type_of(format).into()
}

#[wasm_bindgen(js_name = inferTitle)]
pub fn infer_title(url: &str, element_title: Option<String>, page_title: Option<String>) -> String {
    media::infer_title(url, element_title.as_deref(), page_title.as_deref())
}

#[wasm_bindgen(js_name = describeCodecs)]
pub fn describe_codecs(codecs: Option<String>) -> JsValue {
    to_js(&media::describe_codecs(codecs.as_deref()))
}

#[wasm_bindgen(js_name = estimateBytes)]
pub fn estimate_bytes(bits_per_second: Option<f64>, duration_sec: Option<f64>) -> Option<f64> {
    media::estimate_bytes(bits_per_second, duration_sec)
}

// ---- replay, tabs, ZIP, resources

use vdh_core::{replay, resources, tabs, zip};

#[wasm_bindgen(js_name = replayHeadersFor)]
pub fn replay_headers_for(frame_url: Option<String>) -> JsValue {
    opt_to_js(replay::replay_headers_for(frame_url.as_deref()))
}

#[wasm_bindgen(js_name = replayDomains)]
pub fn replay_domains(urls: Vec<String>, max: usize) -> Vec<String> {
    replay::replay_domains(urls.iter().map(String::as_str), max)
}

#[wasm_bindgen(js_name = ruleIdFor)]
pub fn rule_id_for(job_id: &str) -> u32 {
    replay::rule_id_for(job_id)
}

#[wasm_bindgen(js_name = tabOf)]
pub fn tab_of(resource: JsValue) -> String {
    tabs::tab_of(&json_in(resource)).into()
}

/// The tab of each resource, in order.
#[wasm_bindgen(js_name = tabsOf)]
pub fn tabs_of(resources: JsValue) -> Vec<String> {
    json_list(resources)
        .iter()
        .map(|r| tabs::tab_of(r).to_string())
        .collect()
}

#[wasm_bindgen(js_name = activeTab)]
pub fn active_tab(counts: JsValue, preferred: Option<String>) -> String {
    tabs::active_tab(&json_in(counts), preferred.as_deref()).into()
}

#[wasm_bindgen(js_name = imageMeetsMinimum)]
pub fn image_meets_minimum(resource: JsValue, min_px: f64) -> bool {
    tabs::image_meets_minimum(&json_in(resource), min_px)
}

/// Frame groups with their items as indexes.
#[wasm_bindgen(js_name = frameGroups)]
pub fn frame_groups(items: JsValue) -> JsValue {
    to_js(&tabs::frame_groups(&json_list(items)))
}

#[wasm_bindgen(js_name = emptyCause)]
pub fn empty_cause(error: bool, blocked_frames: f64, reload_pending: bool) -> String {
    tabs::empty_cause(error, blocked_frames, reload_pending).into()
}

#[wasm_bindgen(js_name = shouldDeflate)]
pub fn should_deflate(ext: Option<String>) -> bool {
    zip::should_deflate(ext.as_deref())
}

#[derive(Deserialize)]
struct ZipName {
    title: String,
    #[serde(default)]
    ext: Option<String>,
}

#[wasm_bindgen(js_name = zipEntryNames)]
pub fn zip_entry_names(items: JsValue) -> Result<Vec<String>, JsError> {
    let items: Vec<ZipName> = from_js(items, "entries")?;
    Ok(zip::zip_entry_names(
        items.iter().map(|i| (i.title.as_str(), i.ext.as_deref())),
    ))
}

#[wasm_bindgen(js_name = planZip)]
pub fn plan_zip(resources: JsValue) -> JsValue {
    to_js(&zip::plan_zip(&json_list(resources)))
}

#[wasm_bindgen(js_name = resourceId)]
pub fn resource_id(url: &str) -> String {
    resources::resource_id(url)
}

#[wasm_bindgen(js_name = mergeResource)]
pub fn merge_resource(existing: JsValue, incoming: JsValue) -> JsValue {
    json_out(&resources::merge_resource(
        &json_in(existing),
        &json_in(incoming),
    ))
}

#[wasm_bindgen(js_name = dedupeResources)]
pub fn dedupe_resources(list: JsValue) -> JsValue {
    json_out(&resources::dedupe_resources(&json_list(list)))
}

/// Resource groups with their items as indexes.
#[wasm_bindgen(js_name = groupIndexes)]
pub fn group_indexes(list: JsValue) -> JsValue {
    to_js(&resources::group_indexes(&json_list(list)))
}

#[wasm_bindgen(js_name = visibleIndexes)]
pub fn visible_indexes(list: JsValue) -> Vec<u32> {
    resources::visible_indexes(&json_list(list))
        .into_iter()
        .map(|i| i as u32)
        .collect()
}

#[wasm_bindgen(js_name = rankOrder)]
pub fn rank_order(list: JsValue) -> Vec<u32> {
    resources::rank_order(&json_list(list))
        .into_iter()
        .map(|i| i as u32)
        .collect()
}

#[wasm_bindgen(js_name = bestHeight)]
pub fn best_height(resource: JsValue) -> f64 {
    resources::best_height(&json_in(resource))
}

#[wasm_bindgen(js_name = actionRank)]
pub fn action_rank(resource: JsValue) -> f64 {
    resources::action_rank(&json_in(resource))
}

// ---- queue

use vdh_core::queue;

#[wasm_bindgen(js_name = stagesFor)]
pub fn stages_for(plan: JsValue) -> Result<Vec<String>, JsError> {
    Ok(queue::stages_for(&from_js(plan, "plan")?)
        .into_iter()
        .map(Into::into)
        .collect())
}

#[wasm_bindgen(js_name = popupQueue)]
pub fn popup_queue(stages: Vec<String>, keep: usize) -> Vec<u32> {
    queue::popup_queue(stages.iter().map(String::as_str), keep)
        .into_iter()
        .map(|i| i as u32)
        .collect()
}

#[wasm_bindgen(js_name = createJob)]
pub fn create_job(id: &str, request: JsValue, plan: JsValue, now: f64) -> Result<JsValue, JsError> {
    Ok(json_out(&queue::create_job(
        id,
        &json_in(request),
        &from_js(plan, "plan")?,
        now,
    )))
}

#[wasm_bindgen(js_name = transitionsFrom)]
pub fn transitions_from(stage: &str) -> Vec<String> {
    queue::transitions(stage)
        .iter()
        .map(|s| (*s).into())
        .collect()
}

#[wasm_bindgen(js_name = canTransition)]
pub fn can_transition(from: &str, to: &str) -> bool {
    queue::can_transition(from, to)
}

#[wasm_bindgen(js_name = isActiveStage)]
pub fn is_active_stage(stage: &str) -> bool {
    queue::is_active(stage)
}

#[wasm_bindgen(js_name = isTerminalStage)]
pub fn is_terminal_stage(stage: &str) -> bool {
    queue::is_terminal(stage)
}

/// The moved job, or `undefined` for a move the table does not allow (the wrapper throws the extension's error).
#[wasm_bindgen(js_name = transition)]
pub fn transition(job: JsValue, to: &str, now: f64, error: JsValue) -> JsValue {
    let error = json_in(error);
    queue::transition(&json_in(job), to, now, Some(&error))
        .map_or(JsValue::UNDEFINED, |j| json_out(&j))
}

#[wasm_bindgen(js_name = retryJob)]
pub fn retry_job(job: JsValue, now: f64) -> JsValue {
    queue::retry_job(&json_in(job), now).map_or(JsValue::UNDEFINED, |j| json_out(&j))
}

#[wasm_bindgen(js_name = withProgress)]
pub fn with_progress(job: JsValue, progress: JsValue, now: f64) -> JsValue {
    json_out(&queue::with_progress(
        &json_in(job),
        &json_in(progress),
        now,
    ))
}

#[wasm_bindgen(js_name = canRestage)]
pub fn can_restage(job: JsValue, chrome_error: Option<String>) -> bool {
    queue::can_restage(&json_in(job), chrome_error.as_deref())
}

#[wasm_bindgen(js_name = restage)]
pub fn restage(job: JsValue, now: f64) -> JsValue {
    queue::restage(&json_in(job), now).map_or(JsValue::UNDEFINED, |j| json_out(&j))
}

#[wasm_bindgen(js_name = speedUpdate)]
pub fn speed_update(state: JsValue, bytes: f64, now_ms: f64) -> JsValue {
    let mut m: queue::SpeedMeter = serde_wasm_bindgen::from_value(state).unwrap_or_default();
    m.update(bytes, now_ms);
    to_js(&m)
}

#[wasm_bindgen(js_name = speedRate)]
pub fn speed_rate(state: JsValue) -> Option<f64> {
    serde_wasm_bindgen::from_value::<queue::SpeedMeter>(state)
        .ok()?
        .bytes_per_second()
}

#[wasm_bindgen(js_name = speedEta)]
pub fn speed_eta(state: JsValue, remaining_bytes: Option<f64>) -> Option<f64> {
    serde_wasm_bindgen::from_value::<queue::SpeedMeter>(state)
        .ok()?
        .eta_seconds(remaining_bytes)
}

// ---- data: URLs (the page scripts keep a TypeScript copy)

use vdh_core::data_url;

#[wasm_bindgen(js_name = inspectDataUrl)]
pub fn inspect_data_url(url: &str) -> JsValue {
    opt_to_js(data_url::inspect_data_url(url))
}

#[wasm_bindgen(js_name = dataHandle)]
pub fn data_handle(url: &str) -> String {
    data_url::data_handle(url)
}

#[wasm_bindgen(js_name = isDataLabel)]
pub fn is_data_label(url: &str) -> bool {
    data_url::is_data_label(url)
}

// ---- page hook reports and page metadata

use vdh_core::{hook_data, metadata};

#[wasm_bindgen(js_name = isInteresting)]
pub fn is_interesting(req: JsValue) -> Result<bool, JsError> {
    Ok(hook_data::is_interesting(&from_js(req, "request")?))
}

#[wasm_bindgen(js_name = parseHookReport)]
pub fn parse_hook_report(raw: JsValue) -> JsValue {
    to_js(&hook_data::parse_hook_report(&json_in(raw)))
}

#[wasm_bindgen(js_name = hookCandidates)]
pub fn hook_candidates(
    report: JsValue,
    frame_id: Option<f64>,
    frame_url: Option<String>,
) -> Result<JsValue, JsError> {
    Ok(json_out(&hook_data::hook_candidates(
        &from_js(report, "hook report")?,
        frame_id,
        frame_url.as_deref(),
    )))
}

/// For each resource, its new `downloadability`, or `null` when the verdict leaves it as it was.
fn changed_verdicts(before: &[serde_json::Value], after: &[serde_json::Value]) -> JsValue {
    let out: Vec<Option<&serde_json::Value>> = before
        .iter()
        .zip(after)
        .map(|(b, a)| (a != b).then(|| &a["downloadability"]))
        .collect();
    to_js(&out)
}

#[wasm_bindgen(js_name = protectedFrameVerdicts)]
pub fn protected_frame_verdicts(
    resources: JsValue,
    protected_by_frame: JsValue,
) -> Result<JsValue, JsError> {
    let frames: Vec<(f64, Vec<String>)> = from_js(protected_by_frame, "frames")?;
    let list = json_list(resources);
    Ok(changed_verdicts(
        &list,
        &hook_data::mark_protected_frames(&list, &frames),
    ))
}

#[wasm_bindgen(js_name = protectedKeySystems)]
pub fn protected_key_systems(systems: Vec<String>) -> Vec<String> {
    hook_data::protected_key_systems(&systems)
}

#[wasm_bindgen(js_name = mseMissingReason)]
pub fn mse_missing_reason(hook_on: bool, site_allowed: bool) -> String {
    hook_data::mse_missing_reason(hook_on, site_allowed).into()
}

#[wasm_bindgen(js_name = mseVerdicts)]
pub fn mse_verdicts(
    resources: JsValue,
    reports: JsValue,
    missing: JsValue,
) -> Result<JsValue, JsError> {
    let reports: Vec<(f64, hook_data::HookReport)> = from_js(reports, "hook reports")?;
    let missing: Vec<(f64, String)> = from_js(missing, "missing hooks")?;
    let list = json_list(resources);
    Ok(changed_verdicts(
        &list,
        &hook_data::mark_mse_resources(&list, &reports, &missing),
    ))
}

#[wasm_bindgen(js_name = safeAbs)]
pub fn safe_abs(raw: JsValue, base: &str) -> Option<String> {
    metadata::safe_abs(Some(&json_in(raw)), base)
}

#[wasm_bindgen(js_name = mediaTypeOfMime)]
pub fn media_type_of_mime(mime: Option<String>) -> Option<String> {
    metadata::media_type_of_mime(mime.as_deref()).map(Into::into)
}

#[wasm_bindgen(js_name = mediaFromMetaTags)]
pub fn media_from_meta_tags(tags: JsValue, base: &str) -> Result<JsValue, JsError> {
    Ok(to_js(&metadata::media_from_meta_tags(
        &from_js::<Vec<_>>(tags, "meta tags")?,
        base,
    )))
}

#[wasm_bindgen(js_name = mediaFromJsonLd)]
pub fn media_from_json_ld(text: &str, base: &str) -> JsValue {
    to_js(&metadata::media_from_json_ld(text, base))
}

#[wasm_bindgen(js_name = mediaFromLinks)]
pub fn media_from_links(links: JsValue, base: &str) -> Result<JsValue, JsError> {
    Ok(to_js(&metadata::media_from_links(
        &from_js::<Vec<_>>(links, "link tags")?,
        base,
    )))
}

#[wasm_bindgen(js_name = mediaFromFeed)]
pub fn media_from_feed(text: &str, base: &str) -> JsValue {
    to_js(&metadata::media_from_feed(text, base))
}

// ---- subtitles

use vdh_core::subtitles;

#[wasm_bindgen(js_name = toSrt)]
pub fn to_srt(text: &str) -> Option<String> {
    subtitles::to_srt(text)
}

#[wasm_bindgen(js_name = detectSubtitleFormat)]
pub fn detect_subtitle_format(text: &str) -> String {
    subtitles::detect_subtitle_format(text).into()
}

#[wasm_bindgen(js_name = parseTimestamp)]
pub fn parse_timestamp(value: &str) -> Option<f64> {
    subtitles::parse_timestamp(value)
}

#[wasm_bindgen(js_name = parseVtt)]
pub fn parse_vtt(text: &str) -> JsValue {
    to_js(&subtitles::parse_vtt(text))
}

#[wasm_bindgen(js_name = timestampMapOffset)]
pub fn timestamp_map_offset(text: &str) -> Option<f64> {
    subtitles::timestamp_map_offset(text)
}

#[wasm_bindgen(js_name = stitchVttSegments)]
pub fn stitch_vtt_segments(segments: Vec<String>) -> JsValue {
    to_js(&subtitles::stitch_vtt_segments(&segments))
}

#[wasm_bindgen(js_name = parseTtml)]
pub fn parse_ttml(text: &str) -> JsValue {
    to_js(&subtitles::parse_ttml(text))
}

#[wasm_bindgen(js_name = formatSrt)]
pub fn format_srt(cues: JsValue) -> Result<String, JsError> {
    Ok(subtitles::format_srt(&from_js::<Vec<_>>(cues, "cues")?))
}

#[wasm_bindgen(js_name = formatVtt)]
pub fn format_vtt(cues: JsValue) -> Result<String, JsError> {
    Ok(subtitles::format_vtt(&from_js::<Vec<_>>(cues, "cues")?))
}

#[wasm_bindgen(js_name = parseSubtitles)]
pub fn parse_subtitles(text: &str) -> JsValue {
    to_js(&subtitles::parse_subtitles(text))
}

#[wasm_bindgen(js_name = decodeSubtitleBytes)]
pub fn decode_subtitle_bytes(bytes: &[u8]) -> String {
    subtitles::decode_subtitle_bytes(bytes)
}

/// `[start, end, start, end, ...]` of the `mdat` payloads, so the wrapper hands out views of the caller's own bytes.
#[wasm_bindgen(js_name = mdatRanges)]
pub fn mdat_ranges(data: &[u8]) -> Vec<f64> {
    let base = data.as_ptr() as usize;
    subtitles::mdat_payloads(data)
        .iter()
        .flat_map(|p| {
            let start = p.as_ptr() as usize - base;
            [start as f64, (start + p.len()) as f64]
        })
        .collect()
}

#[wasm_bindgen(js_name = cuesFromBytes)]
pub fn cues_from_bytes(bytes: &[u8]) -> JsValue {
    to_js(&subtitles::cues_from_bytes(bytes))
}

/// The parts of a segmented subtitle stream, concatenated, with their lengths.
#[wasm_bindgen(js_name = assembleCues)]
pub fn assemble_cues(joined: &[u8], lengths: Vec<u32>) -> JsValue {
    let mut parts = Vec::with_capacity(lengths.len());
    let mut at = 0usize;
    for n in lengths {
        let end = (at + n as usize).min(joined.len());
        parts.push(&joined[at..end]);
        at = end;
    }
    to_js(&subtitles::assemble_cues(&parts))
}

// ---- MediaSource captures

use vdh_core::mse;

#[wasm_bindgen(js_name = parseInit)]
pub fn parse_init(data: &[u8]) -> JsValue {
    opt_to_js(mse::parse_init(data))
}

#[wasm_bindgen(js_name = parseFragment)]
pub fn parse_fragment(data: &[u8]) -> JsValue {
    opt_to_js(mse::parse_fragment(data))
}

#[wasm_bindgen(js_name = mediaStartInInit)]
pub fn media_start_in_init(data: &[u8]) -> Option<f64> {
    mse::media_start_in_init(data).map(|n| n as f64)
}

#[wasm_bindgen(js_name = chunkSignature)]
pub fn chunk_signature(data: &[u8]) -> String {
    mse::chunk_signature(data)
}

fn init_of(known: JsValue) -> Result<Option<mse::InitInfo>, JsError> {
    if known.is_undefined() || known.is_null() {
        Ok(None)
    } else {
        from_js(known, "init").map(Some)
    }
}

/// One append classified (split in two when it holds an initialisation and a media segment), given the SourceBuffer's
/// latest initialisation segment (`undefined` when none yet).
#[wasm_bindgen(js_name = classifyChunks)]
pub fn classify_chunks(
    track: &str,
    seq: f64,
    bytes: &[u8],
    offset: f64,
    known: JsValue,
) -> Result<JsValue, JsError> {
    Ok(to_js(&mse::classify_all(
        track,
        seq,
        bytes,
        offset,
        init_of(known)?.as_ref(),
    )))
}

/// One append classified as a whole.
#[wasm_bindgen(js_name = classifyChunk)]
pub fn classify_chunk(
    track: &str,
    seq: f64,
    bytes: &[u8],
    offset: f64,
    known: JsValue,
) -> Result<JsValue, JsError> {
    Ok(to_js(&mse::classify(
        track,
        seq,
        bytes,
        offset,
        init_of(known)?.as_ref(),
    )))
}

#[wasm_bindgen(js_name = planParts)]
pub fn plan_parts(metas: JsValue) -> Result<JsValue, JsError> {
    Ok(to_js(&mse::plan_parts(&from_js::<Vec<_>>(
        metas, "chunks",
    )?)))
}
