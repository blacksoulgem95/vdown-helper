//! The `vdh` binary against the extension's E2E fixture servers (`e2e/fixture-server.mjs`): every output is checked
//! with ffprobe and a full decode, protected streams must be refused.
//!
//! Needs node (with `npm ci` done) and ffmpeg/ffprobe on the PATH. Without them the tests pass with a note, unless
//! `VDH_REQUIRE_FIXTURES=1` (CI on Linux) makes a missing tool a failure.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;

use serde_json::Value;

struct Fixtures {
    a: String,
    root: PathBuf,
    // kept so the server lives as long as the tests: it stops when this pipe closes
    _server: std::sync::Mutex<Child>,
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn have(tool: &str) -> bool {
    Command::new(tool)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn start() -> Result<Fixtures, String> {
    for tool in ["ffmpeg", "ffprobe"] {
        if !have(tool) {
            return Err(format!("{tool} is not on the PATH"));
        }
    }
    let mut child = Command::new("node")
        .arg(repo().join("e2e/fixture-server.mjs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("node could not be started: {e}"))?;
    let out = child.stdout.take().ok_or("no stdout")?;
    let mut line = String::new();
    BufReader::new(out)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let v: Value =
        serde_json::from_str(&line).map_err(|e| format!("fixture server said {line:?}: {e}"))?;
    Ok(Fixtures {
        a: v["a"].as_str().ok_or("no base URL")?.to_string(),
        root: PathBuf::from(v["root"].as_str().ok_or("no root")?),
        _server: std::sync::Mutex::new(child),
    })
}

/// The shared fixture servers, or `None` (with a note) when the tools are missing and not required.
fn fixtures() -> Option<&'static Fixtures> {
    static F: OnceLock<Result<Fixtures, String>> = OnceLock::new();
    match F.get_or_init(start) {
        Ok(f) => Some(f),
        Err(e) if std::env::var("VDH_REQUIRE_FIXTURES").as_deref() == Ok("1") => {
            panic!("fixtures required: {e}")
        }
        Err(e) => {
            eprintln!("skipped: {e}");
            None
        }
    }
}

struct Run {
    code: i32,
    json: Value,
}

fn vdh(args: &[&str]) -> Run {
    let out = Command::new(env!("CARGO_BIN_EXE_vdh"))
        .args(args)
        .output()
        .expect("vdh runs");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let json = serde_json::from_str(stdout.lines().last().unwrap_or("null")).unwrap_or(Value::Null);
    Run {
        code: out.status.code().unwrap_or(-1),
        json,
    }
}

fn out_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("vdh-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("temp dir");
    d
}

fn get(f: &Fixtures, path: &str, name: &str, extra: &[&str]) -> PathBuf {
    let dir = out_dir(name);
    let url = format!("{}/{path}", f.a);
    let mut args = vec!["get", url.as_str(), "-o", dir.to_str().expect("utf-8 path")];
    args.extend_from_slice(extra);
    let r = vdh(&args);
    assert_eq!(r.code, 0, "{path}: {}", r.json);
    assert!(
        !dir.join(".vdh-partial").exists(),
        "{path}: staging left behind"
    );
    PathBuf::from(r.json["path"].as_str().expect("a path"))
}

struct Probe {
    duration: f64,
    streams: Vec<String>,
    codecs: Vec<String>,
}

fn probe(file: &Path) -> Probe {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .expect("ffprobe runs");
    let v: Value = serde_json::from_slice(&out.stdout).expect("ffprobe JSON");
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    Probe {
        duration: v["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .unwrap_or(0.0),
        streams: streams
            .iter()
            .filter_map(|s| s["codec_type"].as_str().map(str::to_string))
            .collect(),
        codecs: streams
            .iter()
            .filter_map(|s| s["codec_name"].as_str().map(str::to_string))
            .collect(),
    }
}

/// Decoding the whole file reports no error.
fn decodes_cleanly(file: &Path) {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(["-f", "null", "-"])
        .output()
        .expect("ffmpeg runs");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success() && err.trim().is_empty(),
        "{}: {err}",
        file.display()
    );
}

fn video_and_audio(file: &Path, seconds: f64) {
    let p = probe(file);
    assert!(
        p.streams.contains(&"video".into()) && p.streams.contains(&"audio".into()),
        "{}: {:?}",
        file.display(),
        p.streams
    );
    assert!(
        (p.duration - seconds).abs() < 0.6,
        "{}: duration {}",
        file.display(),
        p.duration
    );
    decodes_cleanly(file);
}

#[test]
fn hls_master_gives_the_best_quality_as_mp4() {
    let Some(f) = fixtures() else { return };
    let file = get(f, "hls/master.m3u8", "master", &[]);
    assert_eq!(file.extension().and_then(|e| e.to_str()), Some("mp4"));
    assert!(
        file.to_string_lossy().contains("360p"),
        "{}",
        file.display()
    );
    video_and_audio(&file, 6.0);
}

#[test]
fn a_lower_quality_can_be_chosen() {
    let Some(f) = fixtures() else { return };
    let file = get(
        f,
        "hls/master.m3u8",
        "variant",
        &["--variant", "1", "--name", "small"],
    );
    assert!(file.ends_with("small.mp4"), "{}", file.display());
    video_and_audio(&file, 6.0);
}

#[test]
fn aes_128_streams_are_decrypted() {
    let Some(f) = fixtures() else { return };
    video_and_audio(&get(f, "hls-aes/index.m3u8", "aes-ts", &[]), 6.0);
    video_and_audio(&get(f, "hls-aes-fmp4/index.m3u8", "aes-fmp4", &[]), 6.0);
}

#[test]
fn separate_audio_is_merged() {
    let Some(f) = fixtures() else { return };
    video_and_audio(&get(f, "hls-sep/master.m3u8", "sep", &[]), 6.0);
}

#[test]
fn dash_video_and_audio_are_merged() {
    let Some(f) = fixtures() else { return };
    video_and_audio(&get(f, "dash-vod/manifest.mpd", "dash", &[]), 6.0);
}

#[test]
fn a_plain_file_arrives_byte_for_byte() {
    let Some(f) = fixtures() else { return };
    let file = get(f, "media/sample.mp4", "file", &[]);
    let want = std::fs::read(f.root.join("media/sample.mp4")).expect("fixture");
    assert_eq!(std::fs::read(&file).expect("output"), want);
}

#[test]
fn audio_is_extracted_and_converted() {
    let Some(f) = fixtures() else { return };
    let file = get(
        f,
        "hls-sep/master.m3u8",
        "mp3",
        &["--mode", "audio-only", "--audio-format", "mp3"],
    );
    let p = probe(&file);
    assert_eq!(p.codecs, ["mp3"], "{}", file.display());
    assert!((p.duration - 6.0).abs() < 0.6, "duration {}", p.duration);
    decodes_cleanly(&file);
}

#[test]
fn protected_streams_are_refused() {
    let Some(f) = fixtures() else { return };
    for path in ["hls-drm/index.m3u8", "dash-drm/manifest.mpd"] {
        let dir = out_dir("drm");
        let r = vdh(&[
            "get",
            &format!("{}/{path}", f.a),
            "-o",
            dir.to_str().expect("utf-8"),
        ]);
        assert_eq!(
            (r.code, r.json["code"].as_str()),
            (2, Some("protected")),
            "{path}: {}",
            r.json
        );
        assert_eq!(
            std::fs::read_dir(&dir).map(Iterator::count).unwrap_or(0),
            0,
            "{path}: something was written"
        );
    }
}

#[test]
fn a_hand_over_request_is_rechecked() {
    let Some(f) = fixtures() else { return };
    // a request claiming an unprotected file, pointing at a DRM playlist: the engine reads the playlist itself
    let r = vdh(&["probe", &format!("{}/hls/master.m3u8", f.a)]);
    let mut req = r.json["request"].clone();
    req["sourceUrl"] = format!("{}/hls-drm/index.m3u8", f.a).into();
    let dir = out_dir("forged");
    let file = dir.join("request.json");
    std::fs::write(&file, req.to_string()).expect("write request");
    let r = vdh(&[
        "run",
        file.to_str().expect("utf-8"),
        "-o",
        dir.to_str().expect("utf-8"),
    ]);
    assert_eq!(r.json["code"].as_str(), Some("protected"), "{}", r.json);
    // the same request unchanged works
    req["sourceUrl"] = format!("{}/hls/v360/index.m3u8", f.a).into();
    std::fs::write(&file, req.to_string()).expect("write request");
    let r = vdh(&[
        "run",
        file.to_str().expect("utf-8"),
        "-o",
        dir.to_str().expect("utf-8"),
    ]);
    assert_eq!(r.code, 0, "{}", r.json);
    video_and_audio(Path::new(r.json["path"].as_str().expect("path")), 6.0);
}

#[test]
fn the_referer_handed_over_is_sent() {
    let Some(f) = fixtures() else { return };
    let path = format!("__ref/media/sample.mp4?need={}", f.a);
    let dir = out_dir("ref");
    let r = vdh(&[
        "get",
        &format!("{}/{path}", f.a),
        "-o",
        dir.to_str().expect("utf-8"),
    ]);
    assert_eq!(r.json["code"].as_str(), Some("http-error"), "{}", r.json);
    let referer = format!("{}/pages/main.html", f.a);
    let file = get(f, &path, "ref-ok", &["--referer", &referer]);
    decodes_cleanly(&file);
}

#[test]
fn a_live_stream_is_recorded_until_it_ends() {
    let Some(f) = fixtures() else { return };
    let id = format!("it{}", std::process::id());
    let file = get(
        f,
        &format!("__live/hls/index.m3u8?id={id}&len=5"),
        "live",
        &[],
    );
    video_and_audio(&file, 10.0);
    let file = get(
        f,
        &format!("__live/hlssep/master.m3u8?id={id}s&len=5"),
        "live-sep",
        &[],
    );
    video_and_audio(&file, 10.0);
}

#[cfg(unix)]
#[test]
fn stopping_a_recording_keeps_what_was_recorded() {
    use std::time::{Duration, Instant};
    let Some(f) = fixtures() else { return };
    let dir = out_dir("live-stop");
    let url = format!(
        "{}/__live/hls/index.m3u8?id=stop{}&len=60",
        f.a,
        std::process::id()
    );
    let child = Command::new(env!("CARGO_BIN_EXE_vdh"))
        .args(["get", &url, "-o", dir.to_str().expect("utf-8")])
        .stdout(Stdio::piped())
        .spawn()
        .expect("vdh runs");
    std::thread::sleep(Duration::from_secs(5));
    let started = Instant::now();
    Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .expect("kill");
    let out = child.wait_with_output().expect("vdh ends");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "stopping took too long"
    );
    let json: Value = serde_json::from_slice(&out.stdout).expect("JSON");
    assert_eq!(json["ok"], true, "{json}");
    let file = PathBuf::from(json["path"].as_str().expect("path"));
    let p = probe(&file);
    assert!(p.duration >= 2.0, "duration {}", p.duration);
    decodes_cleanly(&file);
}
