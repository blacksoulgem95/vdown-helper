//! Replays the golden fixtures recorded from the TypeScript implementation (core/fixtures/golden/*.jsonl): every case
//! is `{ fn, args, result }` (or `throws` with the error message), and the Rust port must give the same JSON. The
//! extension's vitest suite checks the wasm build against the same files.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde_json::Value;
use vdh_core::{
    analyze, compat, dash, data_url, ffmpeg_args, filetypes, hls, hook_data, inspect, media,
    metadata, mse, queue, replay, request, resources, security, settings, sniff, subtitles, tabs,
    xml, zip,
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
        _ => return run_064(fun, args),
    };
    Some(Ok(v))
}

fn list(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn strs(v: &Value) -> impl Iterator<Item = &str> {
    list(v).iter().filter_map(Value::as_str)
}

/// A recorded `Map` (`{ $map: [[key, value], ...] }`) as pairs.
fn entries<T: DeserializeOwned>(v: &Value) -> Vec<(f64, T)> {
    list(&v["$map"])
        .iter()
        .map(|e| {
            (
                e[0].as_f64().expect("numeric key"),
                serde_json::from_value(e[1].clone()).expect("map value"),
            )
        })
        .collect()
}

fn opt_f(args: &[Value], i: usize) -> Option<f64> {
    args.get(i).and_then(Value::as_f64)
}

/// The modules ported in VDH-064.
fn run_064(fun: &str, args: &[Value]) -> Option<Result<Value, String>> {
    let v = match fun {
        "formatBytes" => json(media::format_bytes(opt_f(args, 0))),
        "formatDuration" => json(media::format_duration(opt_f(args, 0))),
        "formatBitrate" => json(media::format_bitrate(opt_f(args, 0))),
        "formatSpeed" => json(media::format_speed(opt_f(args, 0))),
        "qualityTag" => json(media::quality_tag(opt_f(args, 0))),
        "resolutionLabel" => json(media::resolution_label(opt_f(args, 0), opt_f(args, 1))),
        "formatFromMime" => opt(media::format_from_mime(opt_s(args, 0))),
        "extensionOf" => json(media::extension_of(s(args, 0))),
        "formatFromUrl" => opt(media::format_from_url(s(args, 0))),
        "mediaTypeOf" => json(media::media_type_of(s(args, 0))),
        "inferTitle" => {
            let o = &args[0];
            json(media::infer_title(
                o["url"].as_str().unwrap_or(""),
                o["elementTitle"].as_str(),
                o["pageTitle"].as_str(),
            ))
        }
        "describeCodecs" => json(media::describe_codecs(opt_s(args, 0))),
        "estimateBytes" => opt(media::estimate_bytes(opt_f(args, 0), opt_f(args, 1))),
        "replayHeadersFor" => opt(replay::replay_headers_for(opt_s(args, 0))),
        "replayDomains" => json(replay::replay_domains(
            strs(&args[0]),
            num(args, 1, 24.0) as usize,
        )),
        "ruleIdFor" => json(replay::rule_id_for(s(args, 0))),
        "tabOf" => json(tabs::tab_of(&args[0])),
        "splitByTab" => json(tabs::split_by_tab(list(&args[0]))),
        "activeTab" => json(tabs::active_tab(&args[0], opt_s(args, 1))),
        "imageMeetsMinimum" => json(tabs::image_meets_minimum(&args[0], num(args, 1, 0.0))),
        "groupByFrame" => json(tabs::group_by_frame(list(&args[0]))),
        "emptyCause" => {
            let o = &args[0];
            json(tabs::empty_cause(
                o["error"].as_bool().unwrap_or(false),
                o["blockedFrames"].as_f64().unwrap_or(0.0),
                o["reloadPending"].as_bool().unwrap_or(false),
            ))
        }
        "shouldDeflate" => json(zip::should_deflate(opt_s(args, 0))),
        "zipEntryNames" => {
            json(zip::zip_entry_names(list(&args[0]).iter().map(|i| {
                (i["title"].as_str().unwrap_or(""), i["ext"].as_str())
            })))
        }
        "planZip" => json(zip::plan_zip(list(&args[0]))),
        "resourceId" => json(resources::resource_id(s(args, 0))),
        "mergeResource" => json(resources::merge_resource(&args[0], &args[1])),
        "dedupeResources" => json(resources::dedupe_resources(list(&args[0]))),
        "groupResources" => json(resources::group_resources(list(&args[0]))),
        "hideCoveredVariants" => json(resources::hide_covered_variants(list(&args[0]))),
        "rankResources" => json(resources::rank_resources(list(&args[0]))),
        "bestMatch" => opt(resources::best_match(list(&args[0]))),
        "bestHeight" => json(resources::best_height(&args[0])),
        "popupQueue" => {
            let jobs = list(&args[0]);
            let shown = queue::popup_queue(
                jobs.iter().map(|j| j["stage"].as_str().unwrap_or("")),
                num(args, 1, 3.0) as usize,
            );
            let hidden = jobs.len() - shown.len();
            serde_json::json!({
                "shown": shown.iter().map(|i| jobs[*i].clone()).collect::<Vec<_>>(),
                "hidden": hidden,
            })
        }
        "stagesFor" => json(queue::stages_for(&arg(args, 0))),
        "createJob" => json(queue::create_job(
            s(args, 0),
            &args[1],
            &arg(args, 2),
            num(args, 3, 0.0),
        )),
        "canTransition" => json(queue::can_transition(s(args, 0), s(args, 1))),
        "transition" => {
            return Some(queue::transition(
                &args[0],
                s(args, 1),
                num(args, 2, 0.0),
                args.get(3),
            ));
        }
        "failJob" => json(queue::fail_job(&args[0], num(args, 1, 0.0), &args[2])),
        "canRetry" => json(queue::can_retry(&args[0])),
        "retryJob" => return Some(queue::retry_job(&args[0], num(args, 1, 0.0))),
        "withProgress" => json(queue::with_progress(&args[0], &args[1], num(args, 2, 0.0))),
        "canRestage" => json(queue::can_restage(&args[0], opt_s(args, 1))),
        "restage" => return Some(queue::restage(&args[0], num(args, 1, 0.0))),
        "isActive" => json(queue::is_active(args[0]["stage"].as_str().unwrap_or(""))),
        "isTerminal" => json(queue::is_terminal(args[0]["stage"].as_str().unwrap_or(""))),
        "isQueued" => json(queue::is_queued(args[0]["stage"].as_str().unwrap_or(""))),
        "canStop" => json(queue::can_stop(args[0]["stage"].as_str().unwrap_or(""))),
        "speedMeterTrace" => {
            let mut m = queue::SpeedMeter::default();
            let outs: Vec<Value> = list(&args[0])
                .iter()
                .map(|e| {
                    m.update(e[0].as_f64().unwrap_or(0.0), e[1].as_f64().unwrap_or(0.0));
                    serde_json::json!([m.bytes_per_second(), m.eta_seconds(e[2].as_f64())])
                })
                .collect();
            json(outs)
        }
        "inspectDataUrl" => opt(data_url::inspect_data_url(s(args, 0))),
        "dataHandle" => json(data_url::data_handle(s(args, 0))),
        "dataLabel" => json(data_url::data_label(s(args, 0), s(args, 1))),
        "blobLabel" => json(data_url::blob_label(s(args, 0))),
        "isDataLabel" => json(data_url::is_data_label(s(args, 0))),
        "isInteresting" => json(hook_data::is_interesting(&arg(args, 0))),
        "parseHookReport" => json(hook_data::parse_hook_report(&args[0])),
        "hookCandidates" => json(hook_data::hook_candidates(
            &arg(args, 0),
            args[1]["frameId"].as_f64(),
            args[1]["frameUrl"].as_str(),
        )),
        "protectedKeySystems" => json(hook_data::protected_key_systems(&arg::<Vec<String>>(
            args, 0,
        ))),
        "markProtectedFrames" => json(hook_data::mark_protected_frames(
            list(&args[0]),
            &entries(&args[1]),
        )),
        "mseMissingReason" => json(hook_data::mse_missing_reason(
            args[0].as_bool().unwrap_or(false),
            args[1].as_bool().unwrap_or(false),
        )),
        "markMseResources" => json(hook_data::mark_mse_resources(
            list(&args[0]),
            &entries(&args[1]),
            &args.get(2).map(entries).unwrap_or_default(),
        )),
        "safeAbs" => opt(metadata::safe_abs(args.first(), s(args, 1))),
        "mediaTypeOfMime" => opt(metadata::media_type_of_mime(opt_s(args, 0))),
        "mediaFromMetaTags" => json(metadata::media_from_meta_tags(
            &arg::<Vec<_>>(args, 0),
            s(args, 1),
        )),
        "mediaFromJsonLd" => json(metadata::media_from_json_ld(s(args, 0), s(args, 1))),
        "mediaFromLinks" => json(metadata::media_from_links(
            &arg::<Vec<_>>(args, 0),
            s(args, 1),
        )),
        "mediaFromFeed" => json(metadata::media_from_feed(s(args, 0), s(args, 1))),
        "detectSubtitleFormat" => json(subtitles::detect_subtitle_format(s(args, 0))),
        "parseTimestamp" => opt(subtitles::parse_timestamp(s(args, 0))),
        "parseVtt" => json(subtitles::parse_vtt(s(args, 0))),
        "timestampMapOffset" => opt(subtitles::timestamp_map_offset(s(args, 0))),
        "stitchVttSegments" => json(subtitles::stitch_vtt_segments(
            &strs(&args[0]).collect::<Vec<_>>(),
        )),
        "parseTtml" => json(subtitles::parse_ttml(s(args, 0))),
        "formatSrt" => json(subtitles::format_srt(&arg::<Vec<_>>(args, 0))),
        "formatVtt" => json(subtitles::format_vtt(&arg::<Vec<_>>(args, 0))),
        "parseSubtitles" => json(subtitles::parse_subtitles(s(args, 0))),
        "toSrt" => opt(subtitles::to_srt(s(args, 0))),
        "decodeSubtitleBytes" => json(subtitles::decode_subtitle_bytes(&bytes(&args[0]))),
        "mdatPayloads" => json(
            subtitles::mdat_payloads(&bytes(&args[0]))
                .iter()
                .map(|p| serde_json::json!({ "$bytes": p }))
                .collect::<Vec<_>>(),
        ),
        "cuesFromBytes" => json(subtitles::cues_from_bytes(&bytes(&args[0]))),
        "assembleCues" => json(subtitles::assemble_cues(
            &list(&args[0]).iter().map(bytes).collect::<Vec<_>>(),
        )),
        "parseInit" => opt(mse::parse_init(&bytes(&args[0]))),
        "parseFragment" => opt(mse::parse_fragment(&bytes(&args[0]))),
        "mediaStartInInit" => opt(mse::media_start_in_init(&bytes(&args[0]))),
        "chunkSignature" => json(mse::chunk_signature(&bytes(&args[0]))),
        "planParts" => json(mse::plan_parts(&arg::<Vec<_>>(args, 0))),
        "classifierTrace" => {
            let mut c = mse::ChunkClassifier::default();
            json(
                list(&args[0])
                    .iter()
                    .map(|call| {
                        c.classify_all(
                            call[0].as_str().unwrap_or(""),
                            call[1].as_f64().unwrap_or(0.0),
                            &bytes(&call[2]),
                            call[3].as_f64().unwrap_or(0.0),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        }
        "exceedsHeldLimit" => json(data_url::exceeds_held_limit(
            num(args, 0, 0.0),
            opt_s(args, 1).unwrap_or("data"),
        )),
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

#[test]
fn ui_helpers_match_typescript() {
    replay("ui.jsonl", 3500);
}

#[test]
fn page_reports_and_metadata_match_typescript() {
    replay("page.jsonl", 350);
}

#[test]
fn subtitles_match_typescript() {
    replay("subtitles.jsonl", 200);
}

#[test]
fn mse_parsing_and_parts_match_typescript() {
    replay("mse.jsonl", 300);
}
