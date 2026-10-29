//! Re-encoding through `vdh encode` and `vdh queue add-encode`: the new files are checked with ffprobe (codecs, size,
//! duration) and a full decode, and the original is never touched. See `common` for what the tests need.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use serde_json::Value;

/// A copy of the fixture video, as a finished download would be (the original must stay as it was).
fn input(f: &Fixtures, dir: &Path) -> PathBuf {
    let to = dir.join("My clip.mp4");
    std::fs::copy(f.root.join("media/sample.mp4"), &to).expect("copy");
    to
}

fn height(file: &Path) -> u64 {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=height",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .expect("ffprobe runs");
    let v: Value = serde_json::from_slice(&out.stdout).expect("ffprobe JSON");
    v["streams"][0]["height"].as_u64().unwrap_or(0)
}

fn encode(input: &Path, out: &Path, extra: &[&str]) -> Run {
    let mut args = vec![
        "encode",
        input.to_str().expect("utf-8"),
        "-o",
        out.to_str().expect("utf-8"),
    ];
    args.extend_from_slice(extra);
    vdh(&args)
}

fn until(what: &str, secs: u64, mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(
            start.elapsed() < Duration::from_secs(secs),
            "timed out waiting for {what}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
fn a_finished_download_is_re_encoded_to_h265_in_matroska() {
    let Some(f) = fixtures() else { return };
    let dir = out_dir("enc-h265");
    let src = input(f, &dir);
    let before = std::fs::read(&src).expect("input");
    let r = encode(
        &src,
        &dir.join("out"),
        &["--codec", "h265", "--container", "mkv"],
    );
    assert_eq!(r.code, 0, "{}", r.json);
    let file = PathBuf::from(r.json["path"].as_str().expect("a path"));
    assert!(
        file.ends_with("out/My clip [H.265].mkv"),
        "{}",
        file.display()
    );
    let p = probe(&file);
    assert_eq!(p.codecs, ["hevc", "aac"], "{}", file.display());
    assert!(
        (p.duration - probe(&src).duration).abs() < 0.3,
        "duration {}",
        p.duration
    );
    decodes_cleanly(&file);
    assert_eq!(
        std::fs::read(&src).expect("input"),
        before,
        "the original changed"
    );
    assert!(
        !dir.join("out/.vdh-partial")
            .read_dir()
            .is_ok_and(|mut d| d.next().is_some())
    );
}

#[test]
fn presets_and_sizes_are_kept_to() {
    let Some(f) = fixtures() else { return };
    let dir = out_dir("enc-presets");
    let src = input(f, &dir);
    let out = dir.join("out");
    let r = encode(&src, &out, &["--preset", "web", "--height", "144"]);
    assert_eq!(r.code, 0, "{}", r.json);
    let web = PathBuf::from(r.json["path"].as_str().expect("a path"));
    assert!(
        web.ends_with("My clip [VP9 144p].webm"),
        "{}",
        web.display()
    );
    assert_eq!(probe(&web).codecs, ["vp9", "opus"]);
    assert_eq!(height(&web), 144);
    decodes_cleanly(&web);
    // the same name again does not overwrite the first file
    let r = encode(&src, &out, &["--preset", "web", "--height", "144"]);
    assert_eq!(r.code, 0, "{}", r.json);
    assert_ne!(r.json["path"].as_str(), web.to_str());
    // a remux into Matroska: the streams as they were
    let r = encode(
        &src,
        &out,
        &["--codec", "copy", "--container", "mkv", "--audio", "copy"],
    );
    assert_eq!(r.code, 0, "{}", r.json);
    let copy = PathBuf::from(r.json["path"].as_str().expect("a path"));
    assert_eq!(probe(&copy).codecs, probe(&src).codecs);
    decodes_cleanly(&copy);
}

#[test]
fn impossible_encodes_and_missing_files_are_refused() {
    let Some(f) = fixtures() else { return };
    let dir = out_dir("enc-refused");
    let src = input(f, &dir);
    let out = dir.join("out");
    for extra in [
        &["--codec", "vp9", "--container", "mp4"][..],
        &["--codec", "copy", "--height", "240"],
        &["--audio", "opus", "--container", "mp4"],
        &["--crf", "70"],
        &[
            "--codec",
            "vp9",
            "--encoder",
            "videotoolbox",
            "--container",
            "mkv",
        ],
        &["--preset", "nonsense"],
    ] {
        let r = encode(&src, &out, extra);
        assert_eq!(
            (r.code, r.json["code"].as_str()),
            (1, Some("invalid")),
            "{extra:?}: {}",
            r.json
        );
    }
    let r = encode(&dir.join("not-there.mp4"), &out, &[]);
    assert_eq!(r.json["code"].as_str(), Some("invalid"), "{}", r.json);
    assert!(!out.exists(), "nothing is written for a refused encode");
}

/// A queue of its own for the re-encode jobs.
struct Queue {
    dir: PathBuf,
}

impl Queue {
    fn db(&self) -> String {
        self.dir.join("q.db").to_string_lossy().into_owned()
    }

    fn cmd(&self, args: &[&str]) -> Run {
        let db = self.db();
        let mut all = args.to_vec();
        all.extend_from_slice(&["--db", &db]);
        vdh(&all)
    }

    fn add(&self, input: &Path, extra: &[&str]) -> String {
        let mut args = vec!["queue", "add-encode", input.to_str().expect("utf-8")];
        args.extend_from_slice(extra);
        let r = self.cmd(&args);
        assert_eq!(r.code, 0, "{}", r.json);
        r.json["id"].as_str().expect("an id").to_string()
    }

    fn job(&self, id: &str) -> Option<Value> {
        self.cmd(&["queue", "list"])
            .json
            .as_array()
            .and_then(|a| a.iter().find(|j| j["id"] == id).cloned())
    }

    fn spawn(&self) -> Child {
        Command::new(env!("CARGO_BIN_EXE_vdh"))
            .args(["queue", "run", "-o"])
            .arg(self.dir.join("out"))
            .args(["--db", &self.db()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("vdh runs")
    }
}

#[test]
fn a_batch_of_re_encodes_runs_in_the_queue_and_is_kept_in_the_history() {
    let Some(f) = fixtures() else { return };
    let q = Queue {
        dir: out_dir("enc-queue"),
    };
    let src = input(f, &q.dir);
    q.add(&src, &["--preset", "compatible", "--label", "Compatible"]);
    q.add(&src, &["--preset", "archive"]);
    let out = q.dir.join("out");
    let r = q.cmd(&[
        "queue",
        "run",
        "-o",
        out.to_str().expect("utf-8"),
        "--until-idle",
    ]);
    assert_eq!(r.code, 0, "{}", r.json);
    let a = out.join("My clip [Compatible].mp4");
    let b = out.join("My clip [AV1].mkv");
    assert_eq!(probe(&a).codecs, ["h264", "aac"]);
    assert_eq!(probe(&b).codecs, ["av1", "opus"]);
    decodes_cleanly(&a);
    decodes_cleanly(&b);
    let history = q.cmd(&["history"]).json;
    let entries = history.as_array().expect("history");
    assert_eq!(entries.len(), 2, "{history}");
    // the source is the file's name, not where it is
    assert!(
        entries
            .iter()
            .all(|h| h["source"] == "My clip.mp4" && h["stage"] == "completed"),
        "{history}"
    );
}

#[test]
fn a_paused_re_encode_starts_again_and_finishes() {
    if fixtures().is_none() {
        return;
    }
    let q = Queue {
        dir: out_dir("enc-pause"),
    };
    // long enough to be caught while it encodes
    let src = q.dir.join("long.mp4");
    let made = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=30",
            "-f",
            "lavfi",
            "-i",
        ])
        .args([
            "sine=frequency=440",
            "-t",
            "20",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(&src)
        .status()
        .expect("ffmpeg runs");
    assert!(made.success());
    let id = q.add(&src, &["--codec", "h265", "--container", "mkv"]);
    let mut child = q.spawn();
    until("the encode under way", 60, || {
        q.job(&id).is_some_and(|j| {
            j["stage"] == "encoding" && j["progress"]["fraction"].as_f64().is_some()
        })
    });
    assert_eq!(q.cmd(&["queue", "pause", &id]).code, 0);
    until("the pause", 30, || {
        q.job(&id)
            .is_some_and(|j| j["stage"] == "detected" && j["paused"] == true)
    });
    let out = q.dir.join("out");
    assert!(
        !out.join("long [H.265].mkv").exists(),
        "a paused encode left a file"
    );
    assert_eq!(q.cmd(&["queue", "resume", &id]).code, 0);
    until("the job to finish", 240, || q.job(&id).is_none());
    child.kill().expect("kill");
    let _ = child.wait();
    let file = out.join("long [H.265].mkv");
    let p = probe(&file);
    assert_eq!(p.codecs, ["hevc", "aac"]);
    assert!((p.duration - 20.0).abs() < 0.5, "duration {}", p.duration);
    decodes_cleanly(&file);
}
