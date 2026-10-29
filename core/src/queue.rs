//! The job state machine from `src/lib/queue.ts`: allowed stage transitions, the stages a plan really passes through,
//! retries, the hand-over of a refused native download, and the throughput meter.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::obj::{num_of, number, object, spread, str_of, truthy};

pub const ACTIVE_STAGES: [&str; 5] = [
    "preparing",
    "downloading",
    "recording",
    "merging",
    "encoding",
];
pub const TERMINAL_STAGES: [&str; 3] = ["completed", "failed", "cancelled"];

/// Finished jobs the popup keeps in view; the rest is one click away, so history never buries the page.
pub const POPUP_FINISHED: usize = 3;

/// Chrome errors that mean "the server refused this request": worth one retry with the frame's headers replayed.
pub const REFUSED_BY_SERVER: [&str; 2] = ["SERVER_FORBIDDEN", "SERVER_UNAUTHORIZED"];

/// Allowed stage transitions. Retry is a separate, explicit operation (see [`retry_job`]).
pub fn transitions(from: &str) -> &'static [&'static str] {
    match from {
        "detected" => &["preparing", "cancelled", "failed"],
        "preparing" => &[
            "downloading",
            "recording",
            "merging",
            "encoding",
            "cancelled",
            "failed",
        ],
        "downloading" => &["merging", "encoding", "completed", "cancelled", "failed"],
        "recording" => &["merging", "completed", "cancelled", "failed"],
        "merging" => &["encoding", "completed", "cancelled", "failed"],
        "encoding" => &["completed", "cancelled", "failed"],
        _ => &[],
    }
}

pub fn can_transition(from: &str, to: &str) -> bool {
    transitions(from).contains(&to)
}

pub fn is_active(stage: &str) -> bool {
    ACTIVE_STAGES.contains(&stage)
}

pub fn is_terminal(stage: &str) -> bool {
    TERMINAL_STAGES.contains(&stage)
}

pub fn is_queued(stage: &str) -> bool {
    stage == "detected"
}

/// A running recording can be stopped (and saved), which is different from cancelling it.
pub fn can_stop(stage: &str) -> bool {
    stage == "recording"
}

/// Which of the jobs (newest first) the popup shows: every job still running or waiting, then the `keep` most recent
/// finished ones. Returns the indexes shown.
pub fn popup_queue<'a>(stages: impl IntoIterator<Item = &'a str>, keep: usize) -> Vec<usize> {
    let mut kept = 0;
    stages
        .into_iter()
        .enumerate()
        .filter(|(_, s)| {
            if !is_terminal(s) {
                return true;
            }
            kept += 1;
            kept <= keep
        })
        .map(|(i, _)| i)
        .collect()
}

/// The parts of a plan that decide its stages.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStages {
    #[serde(default)]
    pub pipeline: String,
    #[serde(default)]
    pub video: String,
    #[serde(default)]
    pub audio: String,
    #[serde(default)]
    pub requires_ffmpeg: Option<bool>,
}

/// Only the stages this job will really pass through, in order (never a simulated one).
pub fn stages_for(plan: &PlanStages) -> Vec<&'static str> {
    // A recording has no download: it records until it is stopped, and is then tidied up (duration, index) by a copy.
    if plan.pipeline == "record" || plan.pipeline == "live" {
        return vec!["detected", "preparing", "recording", "merging", "completed"];
    }
    let mut stages = vec!["detected", "preparing", "downloading"];
    if plan.requires_ffmpeg == Some(true) {
        let reencodes = plan.audio == "transcode" || plan.video == "transcode";
        stages.push(if reencodes { "encoding" } else { "merging" });
    }
    stages.push("completed");
    stages
}

pub fn create_job(id: &str, request: &Value, plan: &PlanStages, now: f64) -> Value {
    let mut job = Map::new();
    job.insert("id".into(), id.into());
    job.insert("request".into(), request.clone());
    job.insert("stage".into(), "detected".into());
    job.insert("progress".into(), Value::Object(Map::new()));
    job.insert("stages".into(), stages_for(plan).into());
    // Only Chrome's own download manager supports pause/resume; the segment pipeline does not.
    job.insert("canPause".into(), (plan.pipeline == "native").into());
    job.insert("paused".into(), false.into());
    job.insert("createdAt".into(), number(now));
    job.insert("updatedAt".into(), number(now));
    job.insert("attempts".into(), 0.into());
    Value::Object(job)
}

/// The message of the extension's `IllegalTransitionError`.
pub fn illegal(from: &str, to: &str) -> String {
    format!("Illegal job transition {from} -> {to}")
}

fn stage(job: &Value) -> &str {
    str_of(job, "stage").unwrap_or("")
}

/// The job moved to `to`, or the `IllegalTransitionError` message for a move the table does not allow.
pub fn transition(job: &Value, to: &str, now: f64, error: Option<&Value>) -> Result<Value, String> {
    if !can_transition(stage(job), to) {
        return Err(illegal(stage(job), to));
    }
    let mut next = object(job);
    next.insert("stage".into(), to.into());
    next.insert("updatedAt".into(), number(now));
    next.insert("paused".into(), false.into());
    match error.filter(|e| !e.is_null()) {
        Some(e) if to == "failed" => {
            next.insert("error".into(), e.clone());
        }
        _ if to != "failed" => {
            next.remove("error");
        }
        _ => {}
    }
    if is_terminal(to) {
        next.insert("finishedAt".into(), number(now));
        if to == "completed" {
            let mut progress = object(job.get("progress").unwrap_or(&Value::Null));
            progress.insert("fraction".into(), 1.into());
            next.insert("progress".into(), Value::Object(progress));
        }
    } else {
        // A new stage restarts measurement; stale numbers from the previous stage would mislead.
        next.insert("progress".into(), Value::Object(Map::new()));
    }
    Ok(Value::Object(next))
}

pub fn fail_job(job: &Value, now: f64, error: &Value) -> Value {
    if can_transition(stage(job), "failed") {
        transition(job, "failed", now, Some(error)).unwrap_or_else(|_| job.clone())
    } else {
        job.clone()
    }
}

pub fn can_retry(job: &Value) -> bool {
    matches!(stage(job), "failed" | "cancelled")
}

/// A failed or cancelled job reset so the scheduler picks it up again.
pub fn retry_job(job: &Value, now: f64) -> Result<Value, String> {
    if !can_retry(job) {
        return Err(illegal(stage(job), "detected"));
    }
    let mut next = object(job);
    next.insert("stage".into(), "detected".into());
    next.insert("progress".into(), Value::Object(Map::new()));
    next.insert("updatedAt".into(), number(now));
    next.insert(
        "attempts".into(),
        number(num_of(job, "attempts").unwrap_or(f64::NAN) + 1.0),
    );
    next.insert("paused".into(), false.into());
    for k in ["error", "finishedAt", "chromeDownloadId", "filePath"] {
        next.remove(k);
    }
    Ok(Value::Object(next))
}

pub fn with_progress(job: &Value, progress: &Value, now: f64) -> Value {
    let mut next = object(job);
    let merged = spread(job.get("progress").unwrap_or(&Value::Null), progress);
    next.insert("progress".into(), Value::Object(merged));
    next.insert("updatedAt".into(), number(now));
    Value::Object(next)
}

/// A native download the server refused may be handed once to the extension's own fetch, with the frame's headers.
pub fn can_restage(job: &Value, chrome_error: Option<&str>) -> bool {
    let req = job.get("request").unwrap_or(&Value::Null);
    stage(job) == "downloading"
        && !truthy(job.get("staged"))
        && req.get("replay").is_some_and(|r| !r.is_null())
        && !truthy(req.get("isHls"))
        && !truthy(req.get("isDash"))
        && chrome_error.is_some_and(|e| REFUSED_BY_SERVER.contains(&e))
}

/// Hand a refused native download to the extension's own fetch pipeline (once): back to PREPARING, no longer pausable.
pub fn restage(job: &Value, now: f64) -> Result<Value, String> {
    if stage(job) != "downloading" || truthy(job.get("staged")) {
        return Err(illegal(stage(job), "preparing"));
    }
    let mut next = object(job);
    next.insert("stage".into(), "preparing".into());
    next.insert("progress".into(), Value::Object(Map::new()));
    next.insert("updatedAt".into(), number(now));
    next.insert("paused".into(), false.into());
    next.insert("canPause".into(), false.into());
    next.insert("viaOffscreen".into(), true.into());
    next.insert("staged".into(), true.into());
    next.remove("chromeDownloadId");
    next.remove("error");
    Ok(Value::Object(next))
}

/// State of an exponentially smoothed throughput meter (plain data, so it can live on either side of the wasm).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedMeter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_t: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_bytes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_t: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate: Option<f64>,
    #[serde(default)]
    pub samples: u32,
}

impl SpeedMeter {
    pub fn update(&mut self, bytes: f64, now_ms: f64) {
        if self.first_t.is_none() {
            self.first_t = Some(now_ms);
        }
        if let (Some(t), Some(b)) = (self.last_t, self.last_bytes)
            && now_ms > t
        {
            let inst = (bytes - b) * 1000.0 / (now_ms - t);
            if inst >= 0.0 {
                self.rate = Some(self.rate.map_or(inst, |r| r * 0.7 + inst * 0.3));
                self.samples += 1;
            }
        }
        self.last_t = Some(now_ms);
        self.last_bytes = Some(bytes);
    }

    /// The smoothed rate, once there are at least 1.5 s of samples.
    pub fn bytes_per_second(&self) -> Option<f64> {
        let (rate, first, last) = (self.rate?, self.first_t?, self.last_t?);
        (last - first >= 1500.0).then_some(rate)
    }

    /// Seconds left, only once the rate is positive and stable (never a wild early guess).
    pub fn eta_seconds(&self, remaining_bytes: Option<f64>) -> Option<f64> {
        let r = self.bytes_per_second()?;
        let rem = remaining_bytes?;
        (r > 0.0 && rem >= 0.0 && self.samples >= 3).then(|| rem / r)
    }
}
