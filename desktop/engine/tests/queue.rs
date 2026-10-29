//! The persistent queue through `vdh queue ...`, against the extension's fixture servers: jobs, history, resume after
//! the process is killed, requests from another process, the bandwidth cap and the schedule window.

mod common;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use serde_json::Value;

/// A queue of its own: database, staging and output folder in a fresh directory.
struct Queue {
    dir: PathBuf,
}

impl Queue {
    fn new(name: &str) -> Self {
        Self { dir: out_dir(name) }
    }

    fn db(&self) -> String {
        self.dir.join("q.db").to_string_lossy().into_owned()
    }

    fn out(&self) -> PathBuf {
        self.dir.join("out")
    }

    fn cmd(&self, args: &[&str]) -> Run {
        let db = self.db();
        let mut all = args.to_vec();
        all.extend_from_slice(&["--db", &db]);
        vdh(&all)
    }

    fn add(&self, url: &str, extra: &[&str]) -> String {
        let mut args = vec!["queue", "add", url];
        args.extend_from_slice(extra);
        let r = self.cmd(&args);
        assert_eq!(r.code, 0, "add {url}: {}", r.json);
        r.json["id"].as_str().expect("an id").to_string()
    }

    fn list(&self) -> Vec<Value> {
        self.cmd(&["queue", "list"])
            .json
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    fn job(&self, id: &str) -> Option<Value> {
        self.list().into_iter().find(|j| j["id"] == id)
    }

    /// `vdh queue run` in the background.
    fn spawn(&self, extra: &[&str]) -> Child {
        let out = self.out();
        Command::new(env!("CARGO_BIN_EXE_vdh"))
            .args([
                "queue",
                "run",
                "-o",
                out.to_str().expect("utf-8"),
                "--db",
                &self.db(),
            ])
            .args(extra)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("vdh runs")
    }

    fn run(&self, extra: &[&str]) -> Run {
        let out = self.out();
        let mut args = vec!["queue", "run", "-o", out.to_str().expect("utf-8")];
        args.extend_from_slice(extra);
        self.cmd(&args)
    }

    fn files(&self) -> Vec<PathBuf> {
        std::fs::read_dir(self.out())
            .map(|d| d.flatten().map(|e| e.path()).collect())
            .unwrap_or_default()
    }

    fn history(&self) -> Vec<Value> {
        self.cmd(&["history"])
            .json
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
}

/// Wait until `check` holds (up to `secs`).
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

fn units_done(job: &Value) -> f64 {
    job["progress"]["unitsDone"].as_f64().unwrap_or(0.0)
}

/// The same stream as one straight download, to compare against.
fn reference(f: &Fixtures, name: &str) -> Vec<u8> {
    let file = get(f, "hls/v360/index.m3u8", name, &["--container", "ts"]);
    std::fs::read(file).expect("reference")
}

fn only_file(q: &Queue) -> PathBuf {
    let files = q.files();
    assert_eq!(files.len(), 1, "{files:?}");
    files[0].clone()
}

#[test]
fn a_queue_runs_its_jobs_and_keeps_a_history_without_tokens() {
    let Some(f) = fixtures() else { return };
    let q = Queue::new("queue");
    q.add(&format!("{}/hls/master.m3u8", f.a), &[]);
    q.add(&format!("{}/media/sample.mp4?token=secret123", f.a), &[]);
    q.add(
        &format!("{}/hls-sep/master.m3u8", f.a),
        &["--mode", "audio-only", "--audio-format", "mp3"],
    );
    // a protected stream is refused when it is added
    let db = q.db();
    let r = vdh(&[
        "queue",
        "add",
        &format!("{}/hls-drm/index.m3u8", f.a),
        "--db",
        &db,
    ]);
    assert_eq!(
        (r.code, r.json["code"].as_str()),
        (2, Some("protected")),
        "{}",
        r.json
    );
    assert_eq!(q.list().len(), 3);

    let r = q.run(&["--until-idle"]);
    assert_eq!(r.code, 0, "{}", r.json);
    assert!(q.list().is_empty(), "finished jobs leave the queue");
    let files = q.files();
    assert_eq!(files.len(), 3, "{files:?}");
    for file in &files {
        decodes_cleanly(file);
    }
    let history = q.history();
    assert_eq!(history.len(), 3);
    assert!(
        history.iter().all(|h| h["stage"] == "completed"),
        "{history:?}"
    );
    let text = serde_json::to_string(&history).expect("json");
    assert!(
        !text.contains("secret123"),
        "the history keeps a token: {text}"
    );
    assert!(
        !q.dir
            .join("q.db.staging")
            .read_dir()
            .is_ok_and(|mut d| d.next().is_some())
    );
}

#[test]
fn a_killed_queue_continues_where_it_was_and_the_file_is_identical() {
    let Some(f) = fixtures() else { return };
    let q = Queue::new("kill");
    let id = q.add(
        &format!("{}/slow/hls/v360/index.m3u8", f.b),
        &["--container", "ts", "--name", "slow"],
    );
    let mut child = q.spawn(&["--segments", "1"]);
    until("a segment staged", 30, || {
        q.job(&id).is_some_and(|j| units_done(&j) >= 1.0)
    });
    child.kill().expect("kill");
    let _ = child.wait();
    let job = q.job(&id).expect("still queued");
    assert!(
        units_done(&job) < 3.0,
        "it finished before it was killed: {job}"
    );

    let out = q.out();
    let run = Command::new(env!("CARGO_BIN_EXE_vdh"))
        .args([
            "queue",
            "run",
            "-o",
            out.to_str().expect("utf-8"),
            "--db",
            &q.db(),
        ])
        .args(["--until-idle", "--segments", "1", "--events"])
        .output()
        .expect("vdh runs");
    assert!(run.status.success());
    // what was staged is not fetched again: the first segment written now is the second one
    let first = String::from_utf8_lossy(&run.stderr)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|e| e["event"]["unitsDone"].as_f64());
    assert_eq!(
        first.map(|n| n >= 2.0),
        Some(true),
        "first progress after the restart: {first:?}"
    );
    let file = only_file(&q);
    assert_eq!(
        std::fs::read(&file).expect("output"),
        reference(f, "kill-ref")
    );
}

#[test]
fn another_process_pauses_resumes_cancels_and_retries() {
    let Some(f) = fixtures() else { return };
    let q = Queue::new("control");
    let id = q.add(
        &format!("{}/slow/hls/v360/index.m3u8", f.b),
        &["--container", "ts", "--name", "ctl"],
    );
    let mut child = q.spawn(&["--segments", "1", "--for", "60"]);
    until("a segment staged", 30, || {
        q.job(&id).is_some_and(|j| units_done(&j) >= 1.0)
    });

    assert_eq!(q.cmd(&["queue", "pause", &id]).code, 0);
    until("the pause", 15, || {
        q.job(&id)
            .is_some_and(|j| j["paused"] == true && j["stage"] == "detected")
    });
    let staged = q.dir.join("q.db.staging").join(&id).join("video.stream");
    assert!(staged.exists(), "a paused job keeps what it staged");
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(
        q.job(&id).expect("queued")["stage"],
        "detected",
        "a paused job does not start again"
    );

    assert_eq!(q.cmd(&["queue", "resume", &id]).code, 0);
    until("the job to finish", 30, || q.job(&id).is_none());
    assert_eq!(
        std::fs::read(only_file(&q)).expect("output"),
        reference(f, "ctl-ref")
    );

    // cancel: nothing is kept; retry: it runs again from the start
    let id = q.add(
        &format!("{}/slow/hls/v360/index.m3u8", f.b),
        &["--container", "ts", "--name", "again"],
    );
    until("a segment staged", 30, || {
        q.job(&id).is_some_and(|j| units_done(&j) >= 1.0)
    });
    assert_eq!(q.cmd(&["queue", "cancel", &id]).code, 0);
    until("the cancel", 15, || {
        q.job(&id).is_some_and(|j| j["stage"] == "cancelled")
    });
    assert!(
        !q.dir.join("q.db.staging").join(&id).exists(),
        "a cancelled job keeps nothing"
    );
    assert!(!q.out().join("again.ts").exists());
    assert_eq!(q.cmd(&["queue", "retry", &id]).code, 0);
    until("the retried job to finish", 30, || q.job(&id).is_none());
    assert!(q.out().join("again.ts").exists());
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn the_bandwidth_cap_holds_for_the_whole_queue() {
    let Some(f) = fixtures() else { return };
    let q = Queue::new("rate");
    q.add(&format!("{}/media/sample.mp4", f.a), &[]);
    let size = std::fs::metadata(f.root.join("media/sample.mp4"))
        .expect("fixture")
        .len() as f64;
    let rate = 300.0 * 1024.0;
    let started = Instant::now();
    assert_eq!(q.run(&["--until-idle", "--rate-kbps", "300"]).code, 0);
    let took = started.elapsed().as_secs_f64();
    // one second of burst, then the cap
    let least = size / rate - 1.0;
    assert!(
        took >= least * 0.9,
        "{size} bytes at 300 KB/s took {took:.2} s (expected at least {least:.2})"
    );
    decodes_cleanly(&only_file(&q));
}

#[test]
fn jobs_wait_for_their_window() {
    use chrono::{Local, Timelike};
    let Some(f) = fixtures() else { return };
    let q = Queue::new("window");
    let id = q.add(&format!("{}/media/sample.mp4", f.a), &[]);
    let h = Local::now().hour();
    let closed = format!("{:02}:00-{:02}:00", (h + 2) % 24, (h + 3) % 24);
    let open = format!("{:02}:00-{:02}:00", (h + 23) % 24, (h + 1) % 24);
    assert_eq!(q.run(&["--window", &closed, "--for", "2"]).code, 0);
    assert_eq!(q.job(&id).expect("waiting")["stage"], "detected");
    assert!(q.files().is_empty());
    assert_eq!(q.run(&["--window", &open, "--until-idle"]).code, 0);
    assert!(q.job(&id).is_none());
    decodes_cleanly(&only_file(&q));
}

#[test]
fn the_history_can_be_turned_off() {
    let Some(f) = fixtures() else { return };
    let q = Queue::new("nohistory");
    assert_eq!(q.cmd(&["history", "--off"]).code, 0);
    q.add(&format!("{}/media/sample.mp4", f.a), &[]);
    assert_eq!(q.run(&["--until-idle"]).code, 0);
    assert!(q.history().is_empty());
    assert_eq!(q.cmd(&["history", "--on"]).code, 0);
    q.add(&format!("{}/media/sample.mp4", f.a), &["--name", "two"]);
    assert_eq!(q.run(&["--until-idle"]).code, 0);
    assert_eq!(q.history().len(), 1);
}
