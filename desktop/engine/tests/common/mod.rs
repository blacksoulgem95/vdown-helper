//! Shared by the integration tests: the extension's E2E fixture servers (`e2e/fixture-server.mjs`), the `vdh` binary
//! and the checks on its outputs (ffprobe and a full decode).
//!
//! Needs node (with `npm ci` done) and ffmpeg/ffprobe on the PATH. Without them the tests pass with a note, unless
//! `VDH_REQUIRE_FIXTURES=1` (CI on Linux) makes a missing tool a failure.

#![allow(dead_code)] // each test file uses part of it

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;

use serde_json::Value;

pub struct Fixtures {
    /// The "website" origin.
    pub a: String,
    /// Another origin; its `/slow/` paths delay every segment by 1.5 s.
    pub b: String,
    pub root: PathBuf,
    // kept so the server lives as long as the tests: it stops when this pipe closes
    _server: std::sync::Mutex<Child>,
}

pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn have(tool: &str) -> bool {
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
        b: v["b"].as_str().ok_or("no base URL")?.to_string(),
        root: PathBuf::from(v["root"].as_str().ok_or("no root")?),
        _server: std::sync::Mutex::new(child),
    })
}

/// The shared fixture servers, or `None` (with a note) when the tools are missing and not required.
pub fn fixtures() -> Option<&'static Fixtures> {
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

pub struct Run {
    pub code: i32,
    pub json: Value,
}

pub fn vdh(args: &[&str]) -> Run {
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

pub fn out_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("vdh-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("temp dir");
    d
}

pub fn get(f: &Fixtures, path: &str, name: &str, extra: &[&str]) -> PathBuf {
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

pub struct Probe {
    pub duration: f64,
    pub streams: Vec<String>,
    pub codecs: Vec<String>,
}

pub fn probe(file: &Path) -> Probe {
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
pub fn decodes_cleanly(file: &Path) {
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

pub fn video_and_audio(file: &Path, seconds: f64) {
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
