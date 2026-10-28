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
