//! Replays the golden fixtures recorded from the TypeScript implementation (core/fixtures/golden/*.jsonl): every case
//! is `{ fn, args, result }` (or `throws` with the error message), and the Rust port must give the same JSON. The
//! extension's vitest suite checks the wasm build against the same files.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::Value;
use vdh_core::{analyze, dash, hls, inspect, xml};

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

/// `Ok(value)` or `Err(message)`; `None` when the function is not ported here.
fn run(fun: &str, args: &[Value]) -> Option<Result<Value, String>> {
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
        let Some(got) = run(fun, args) else { continue };
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
