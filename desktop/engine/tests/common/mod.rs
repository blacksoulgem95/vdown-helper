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
///
/// Opus in Matroska/WebM: FFmpeg 8.0's decoding of the last, end-trimmed Opus packet from Matroska fails although the
/// stored bytes are correct (the same packet copied into Ogg decodes cleanly; VDH-081). So the rest of the file is
/// decoded as it is and the Opus packets, copied unchanged into Ogg, are decoded there: every packet is still checked.
pub fn decodes_cleanly(file: &Path) {
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("");
    let opus_in_matroska =
        matches!(ext, "mkv" | "webm") && probe(file).codecs.iter().any(|c| c == "opus");
    if opus_in_matroska {
        decodes(file, &["-map", "0", "-map", "-0:a"]);
        let ogg = file.with_extension("opus-check.ogg");
        let copied = Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-i"])
            .arg(file)
            .args(["-map", "0:a", "-c", "copy"])
            .arg(&ogg)
            .output()
            .expect("ffmpeg runs");
        assert!(
            copied.status.success(),
            "{}: {}",
            file.display(),
            String::from_utf8_lossy(&copied.stderr)
        );
        decodes(&ogg, &[]);
        let _ = std::fs::remove_file(&ogg);
    } else {
        decodes(file, &[]);
    }
}

fn decodes(file: &Path, map: &[&str]) {
    let out = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(file)
        .args(map)
        .args(["-f", "null", "-"])
        .output()
        .expect("ffmpeg runs");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        out.status.success() && err.trim().is_empty(),
        "{}: {err}\n{}",
        file.display(),
        decode_report(file)
    );
}

/// Which packets a failed decode stopped at: the lines before the first errors (with each packet's timestamps) and the
/// audio packets of the file, first and last.
fn decode_report(file: &Path) -> String {
    let run = |args: &[&str]| {
        Command::new(args[0])
            .args(&args[1..])
            .arg(file)
            .args(if args[0] == "ffmpeg" {
                &["-f", "null", "-"][..]
            } else {
                &[]
            })
            .output()
            .map(|o| {
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&o.stdout),
                    String::from_utf8_lossy(&o.stderr)
                )
            })
            .unwrap_or_default()
    };
    let version = run(&["ffmpeg", "-hide_banner", "-version", "-i"]);
    let traced = run(&["ffmpeg", "-hide_banner", "-debug_ts", "-i"]);
    let lines: Vec<&str> = traced.lines().collect();
    let errors: Vec<usize> = (0..lines.len())
        .filter(|&i| lines[i].contains("Error") || lines[i].contains("error"))
        .collect();
    let mut report = format!(
        "{}\n{} error line(s) of {} traced lines\n",
        version.lines().next().unwrap_or(""),
        errors.len(),
        lines.len()
    );
    for &i in errors.iter().take(3) {
        report.push_str("--- before an error:\n");
        for l in &lines[i.saturating_sub(4)..=i] {
            report.push_str(l);
            report.push('\n');
        }
    }
    let packets = run(&[
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "packet=pts,duration,size,flags:stream=codec_name,sample_rate,channels,initial_padding",
        "-of",
        "csv",
    ]);
    let p: Vec<&str> = packets.lines().collect();
    report.push_str(&format!(
        "--- {} audio packet line(s); first and last:\n",
        p.len()
    ));
    for l in p
        .iter()
        .take(4)
        .chain(p.iter().skip(p.len().saturating_sub(4)))
    {
        report.push_str(l);
        report.push('\n');
    }
    report
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
