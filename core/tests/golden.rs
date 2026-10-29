//! Replays the golden fixtures recorded from the TypeScript implementation (core/fixtures/golden/*.jsonl): every case
//! is `{ fn, args, result }` (or `throws` with the error message), and the Rust port must give the same JSON. The
//! extension's vitest suite checks the wasm build against the same files.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::Value;
use vdh_core::{
    analyze, compat, dash, ffmpeg_args, filetypes, hls, inspect, request, security, settings,
    sniff, xml,
};

/// JSON equality where every number compares as f64 (JavaScript has one number type) and an absent field equals null
/// only where JavaScript would also have left it out.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w)))
        }
        _ => a == b,
    }
}

fn s(args: &[Value], i: usize) -> &str {
    args[i].as_str().expect("string argument")
}

fn arg<T: DeserializeOwned>(args: &[Value], i: usize) -> T {
    serde_json::from_value(args[i].clone()).expect("argument of the right shape")
}

fn json<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).expect("serialisable")
}

/// `undefined` is recorded as an absent `result`.
fn opt<T: serde::Serialize>(v: Option<T>) -> Value {
    v.map_or(Value::Null, json)
}

fn opt_s(args: &[Value], i: usize) -> Option<&str> {
    args.get(i).and_then(Value::as_str)
}

fn bytes(v: &Value) -> Vec<u8> {
    v["$bytes"]
        .as_array()
        .expect("bytes")
        .iter()
        .map(|b| b.as_u64().expect("byte") as u8)
        .collect()
}

fn num(args: &[Value], i: usize, default: f64) -> f64 {
    args.get(i).and_then(Value::as_f64).unwrap_or(default)
}

fn inspection(args: &[Value], i: usize) -> Option<request::InspectionFacts> {
    args.get(i)
        .filter(|v| !v.is_null())
        .map(|v| serde_json::from_value(v.clone()).expect("inspection"))
}

/// `Ok(value)` or `Err(message)`; `None` when the function is not ported here.
fn run(fun: &str, args: &[Value], today: &str) -> Option<Result<Value, String>> {
    let v = match fun {
        "parseHls" => json(hls::parse_hls(s(args, 0), s(args, 1))),
        "classifyPlaylist" => json(hls::classify_playlist(s(args, 0))),
        "parseAttributes" => json(hls::attributes::parse_attributes(s(args, 0))),
        "parseXml" => {
            let mut limits = xml::XmlLimits::default();
            if let Some(l) = args.get(1) {
                if let Some(n) = l["maxNodes"].as_u64() {
                    limits.max_nodes = n as usize;
                }
                if let Some(d) = l["maxDepth"].as_u64() {
                    limits.max_depth = d as usize;
                }
            }
            opt(xml::parse_xml(s(args, 0), limits))
        }
        "decodeEntities" => json(xml::decode_entities(s(args, 0))),
        "parseDash" => json(dash::parse_dash(s(args, 0), s(args, 1))),
        "parseIsoDuration" => opt(dash::parse_iso_duration(
            args.first().and_then(Value::as_str),
        )),
        "mainPeriodIndex" => json(dash::main_period_index(&arg(args, 0))),
        "periodDuration" => opt(dash::period_duration(&arg(args, 0), &arg(args, 1))),
        "protectionsOf" => json(dash::protections_of(&arg::<Vec<dash::DashRepresentation>>(
            args, 0,
        ))),
        "substitute" => {
            let vars: HashMap<String, Value> = arg(args, 1);
            let vars: HashMap<&str, dash::Var> = vars
                .iter()
                .map(|(k, v)| {
                    let var = match v {
                        Value::String(x) => dash::Var::Str(x.clone()),
                        other => dash::Var::Num(other.as_f64().expect("number")),
                    };
                    (k.as_str(), var)
                })
                .collect();
            json(dash::substitute(s(args, 0), &vars))
        }
        "expandSegments" => {
            let r = dash::expand_segments(
                &arg(args, 0),
                &arg(args, 1),
                &arg(args, 2),
                args[3].as_f64().expect("now"),
            );
            return Some(r.map(json));
        }
        "dashResource" => json(analyze::dash_resource(s(args, 0), s(args, 1))),
        "mediaPlaylistVerdict" => json(analyze::media_playlist_verdict(&arg(args, 0))),
        "inspectMediaPlaylist" => json(inspect::inspect_media_playlist(&arg(args, 0))),
        "inspectDashRepresentation" => {
            let r = inspect::inspect_dash_representation(
                &arg(args, 0),
                &arg(args, 1),
                &arg(args, 2),
                args[3].as_f64().expect("now"),
            );
            return Some(r.map(json));
        }
        "originsOf" => json(inspect::origins_of(
            args[0]
                .as_array()
                .expect("urls")
                .iter()
                .filter_map(Value::as_str),
            args.get(1)
                .and_then(Value::as_u64)
                .map_or(24, |m| m as usize),
        )),
        "sampleByOrigin" => json(inspect::sample_by_origin(
            args[0]
                .as_array()
                .expect("urls")
                .iter()
                .filter_map(Value::as_str),
            args.get(1)
                .and_then(Value::as_u64)
                .map_or(24, |m| m as usize),
        )),
        "fileKindOfExtension" => opt(filetypes::file_kind_of_extension(opt_s(args, 0))),
        "extensionForMime" => opt(filetypes::extension_for_mime(opt_s(args, 0))),
        "fileKindOfMime" => opt(filetypes::file_kind_of_mime(opt_s(args, 0))),
        "urlExtension" => json(filetypes::url_extension(s(args, 0))),
        "fileStem" => json(filetypes::file_stem(s(args, 0))),
        "sniffMime" => opt(sniff::sniff_mime(&bytes(&args[0]))),
        "isSafeFetchUrl" => json(security::is_safe_fetch_url(s(args, 0))),
        "isBlobUrl" => json(security::is_blob_url(s(args, 0))),
        "isPrivateHost" => json(security::is_private_host(s(args, 0))),
        "mayExtensionFetch" => json(security::may_extension_fetch(s(args, 0), s(args, 1))),
        "normalizeUrl" => json(security::normalize_url(s(args, 0))),
        "redactUrl" => json(security::redact_url(s(args, 0))),
        "redactText" => json(security::redact_text(s(args, 0))),
        "sanitizeFilename" => json(security::sanitize_filename(
            s(args, 0),
            opt_s(args, 1).unwrap_or("video"),
            num(args, 2, 150.0) as usize,
        )),
        "sanitizeSubfolder" => json(security::sanitize_subfolder(s(args, 0))),
        "asciiFileName" => json(security::ascii_file_name(s(args, 0))),
        "withExtension" => json(security::with_extension(s(args, 0), s(args, 1))),
        "renderNameTemplate" => json(security::render_name_template(s(args, 0), &arg(args, 1))),
        "sanitizeSettings" => json(settings::sanitize_settings(
            args.first().unwrap_or(&Value::Null),
        )),
        "migrateHookDefault" => {
            let applied: Vec<String> = arg(args, 1);
            opt(settings::migrate_hook_default(&args[0], &applied))
        }
        "pickVariantIndex" => {
            let hs: Vec<Option<f64>> = arg(args, 0);
            json(settings::pick_variant_index(&hs, s(args, 1)))
        }
        "videoFitsContainer" => json(compat::video_fits_container(opt_s(args, 0), s(args, 1))),
        "audioFitsContainer" => json(compat::audio_fits_container(opt_s(args, 0), s(args, 1))),
        "sourceFitsContainer" => json(compat::source_fits_container(s(args, 0), s(args, 1))),
        "fileExtension" => json(compat::file_extension(s(args, 0))),
        "audioExtension" => json(compat::audio_extension(s(args, 0))),
        "planOutput" => json(compat::plan_output(&arg(args, 0))),
        "bitrateOptions" => json(compat::bitrate_options(&arg(args, 0))),
        "buildFfmpegArgs" => json(ffmpeg_args::build_ffmpeg_args(&arg(args, 0))),
        "audioOptions" => {
            let r: request::MediaResource = arg(args, 0);
            let v: Option<hls::HlsVariant> = args
                .get(1)
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()).expect("variant"));
            json(request::audio_options(&r, v.as_ref()))
        }
        "defaultChoices" => json(request::default_choices(&arg(args, 0), &arg(args, 1))),
        "workableChoices" => json(request::workable_choices(
            &arg(args, 0),
            &arg(args, 1),
            &arg(args, 2),
            inspection(args, 3).as_ref(),
            today,
        )),
        "defaultSubtitleOutput" => json(request::default_subtitle_output(&arg(args, 0))),
        "buildZipRequest" => opt(request::build_zip_request(
            &arg::<Vec<request::MediaResource>>(args, 0),
            &arg(args, 1),
        )),
        "buildRequest" => json(request::build_request(
            &arg(args, 0),
            &arg(args, 1),
            &arg(args, 2),
            inspection(args, 3).as_ref(),
            today,
        )),
        "qualityLabelFor" => {
            let r = &args[0];
            json(request::quality_label_for(
                r["mode"].as_str().unwrap_or(""),
                r["audioFormat"].as_str().unwrap_or(""),
                r["sourceFormat"].as_str().unwrap_or(""),
                args.get(1).and_then(Value::as_f64),
            ))
        }
        "planFromRequest" => json(request::plan_from_request(&arg(args, 0), arg(args, 1))),
        "buildLiveRequest" => json(request::build_live_request(
            &arg(args, 0),
            &arg(args, 1),
            today,
        )),
        "buildRecordRequest" => json(request::build_record_request(
            &arg(args, 0),
            &arg(args, 1),
            today,
        )),
        "buildCaptureRequest" => json(request::build_capture_request(
            &arg(args, 0),
            &arg(args, 1),
            s(args, 2),
            today,
        )),
        "zipLimitBytes" => json(request::zip_limit_bytes(num(args, 0, 0.0))),
        "sanitizeRequest" => opt(request::sanitize_request(&args[0])),
        "dashRef" => json(dash::dash_ref(s(args, 0), s(args, 1))),
        "parseDashRef" => opt(dash::parse_dash_ref(s(args, 0))),
        _ => return None,
    };
    Some(Ok(v))
}

fn clip(s: &str) -> String {
    s.chars().take(400).collect()
}

fn replay(file: &str, min: usize) {
    let path = format!("{}/fixtures/golden/{file}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).expect("golden file");
    let mut checked = 0;
    let mut failures = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let case: Value = serde_json::from_str(line).expect("valid JSON line");
        let fun = case["fn"].as_str().unwrap_or_default();
        let args = case["args"].as_array().expect("args");
        let today = case["today"].as_str().unwrap_or("2026-01-01");
        let Some(got) = run(fun, args, today) else {
            continue;
        };
        checked += 1;
        let ok = match (&got, case.get("throws")) {
            (Err(msg), Some(want)) => want.as_str() == Some(msg.as_str()),
            (Ok(v), None) => same(v, case.get("result").unwrap_or(&Value::Null)),
            _ => false,
        };
        if !ok {
            failures.push(format!(
                "line {}: {fun}({})\n  expected {}\n  got      {}",
                n + 1,
                clip(&serde_json::to_string(args).unwrap_or_default()),
                clip(
                    &case
                        .get("result")
                        .or(case.get("throws"))
                        .unwrap_or(&Value::Null)
                        .to_string()
                ),
                clip(&format!("{got:?}"))
            ));
        }
    }
    assert!(checked >= min, "{file}: only {checked} cases");
    assert!(
        failures.is_empty(),
        "{file}: {} of {checked} differ:\n{}",
        failures.len(),
        failures
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn hls_matches_typescript() {
    replay("hls.jsonl", 400);
}

#[test]
fn dash_and_xml_match_typescript() {
    replay("dash.jsonl", 500);
}

#[test]
fn verdicts_and_inspections_match_typescript() {
    replay("analyze.jsonl", 150);
}

#[test]
fn files_and_security_match_typescript() {
    replay("files.jsonl", 3000);
}

#[test]
fn planner_matches_typescript() {
    replay("planner.jsonl", 1000);
}

#[test]
fn requests_match_typescript() {
    replay("requests.jsonl", 1500);
}
