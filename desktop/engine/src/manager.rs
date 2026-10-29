//! The download manager: a persistent queue of jobs run a few at a time, that survives the app being closed or killed.
//!
//! Jobs are stored in the extension's `DownloadJob` shape and moved through `vdh-core`'s state machine. A job that was
//! running when the process died goes back to the queue and continues from the checkpoints of its staged tracks.
//! Requests to pause, resume, retry, cancel, stop or remove a job are written to the database and applied by the running
//! queue, so they work from another process too. A global bandwidth cap and a schedule window apply to every job.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use vdh_core::queue::{PlanStages, create_job, retry_job, transition, with_progress};
use vdh_core::request::DownloadRequest;
use vdh_core::security::redact_url;

use crate::error::{EngineError, ErrorCode, Result};
use crate::job::{self, Checkpoints, Event, JobContext};
use crate::limit::RateLimit;
use crate::net::{Net, RequestHeaders};
use crate::schedule::Window;
use crate::stage::TrackCheckpoint;
use crate::store::{HistoryEntry, Store, StoredHeaders, StoredJob};

#[derive(Debug, Clone)]
pub struct ManagerOptions {
    /// Where finished files go.
    pub out_dir: PathBuf,
    /// Staging for running and paused jobs (one folder per job).
    pub staging_dir: PathBuf,
    /// Jobs at a time.
    pub max_jobs: usize,
    /// Segments at a time, per job.
    pub segment_concurrency: usize,
    /// Global bandwidth cap in bytes per second (0 = none).
    pub rate_bps: u64,
    /// When jobs may run (`None` = always).
    pub window: Option<Window>,
}

impl ManagerOptions {
    pub fn new(out_dir: PathBuf, staging_dir: PathBuf) -> Self {
        Self {
            out_dir,
            staging_dir,
            max_jobs: 3,
            segment_concurrency: 4,
            rate_bps: 0,
            window: None,
        }
    }
}

/// Why a running job is being interrupted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Interrupt {
    /// The user paused it: it waits until resumed.
    Pause,
    /// The schedule window closed (or the queue is shutting down): it goes back to the queue as it is.
    Hold,
    Cancel,
    Remove,
}

struct Running {
    cancel: CancellationToken,
    stop: CancellationToken,
    paused: Arc<AtomicBool>,
    why: Arc<Mutex<Option<Interrupt>>>,
    handle: JoinHandle<()>,
}

/// One job's record while it runs: kept in memory, written to the database on every stage and at most twice a second
/// for progress.
struct Live {
    job: Value,
    saved: Instant,
}

pub type EventSink = Arc<dyn Fn(&str, &Event) + Send + Sync>;

pub struct Manager {
    store: Arc<Store>,
    opts: Mutex<ManagerOptions>,
    limit: Arc<RateLimit>,
    running: Mutex<HashMap<String, Running>>,
    on_event: EventSink,
}

fn now_ms() -> f64 {
    crate::stage::now_ms()
}

/// A new job id, unique across processes adding to the same queue.
fn new_id() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "j{:x}-{:x}-{}",
        now_ms() as u64,
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

fn stage_of(job: &Value) -> &str {
    job.get("stage").and_then(Value::as_str).unwrap_or("")
}

fn is_paused(job: &Value) -> bool {
    job.get("paused").and_then(Value::as_bool).unwrap_or(false)
}

/// Back to the queue, waiting: progress restarts, what was staged stays (its checkpoints decide what is fetched again).
fn requeue(job: &Value, paused: bool) -> Value {
    let mut j = vdh_core::obj::object(job);
    j.insert("stage".into(), "detected".into());
    j.insert("progress".into(), Value::Object(Map::new()));
    j.insert("paused".into(), paused.into());
    j.insert("updatedAt".into(), vdh_core::obj::number(now_ms()));
    j.remove("error");
    Value::Object(j)
}

struct StoreCheckpoints {
    store: Arc<Store>,
    id: String,
}

impl Checkpoints for StoreCheckpoints {
    fn load(&self, track: &str) -> Option<TrackCheckpoint> {
        self.store.checkpoint(&self.id, track)
    }

    fn save(&self, track: &str, cp: &TrackCheckpoint) {
        let _ = self.store.save_checkpoint(&self.id, track, cp);
    }
}

impl Manager {
    pub fn new(store: Arc<Store>, opts: ManagerOptions, on_event: EventSink) -> Self {
        let limit = Arc::new(RateLimit::new(opts.rate_bps));
        Self {
            store,
            opts: Mutex::new(opts),
            limit,
            running: Mutex::new(HashMap::new()),
            on_event,
        }
    }

    pub fn store(&self) -> &Arc<Store> {
        &self.store
    }

    fn options(&self) -> ManagerOptions {
        self.opts
            .lock()
            .map(|o| o.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    /// Change the bandwidth cap while jobs run (0 = none).
    pub fn set_rate(&self, bytes_per_second: u64) {
        self.limit.set_rate(bytes_per_second);
        if let Ok(mut o) = self.opts.lock() {
            o.rate_bps = bytes_per_second;
        }
    }

    pub fn set_window(&self, window: Option<Window>) {
        if let Ok(mut o) = self.opts.lock() {
            o.window = window;
        }
    }

    /// Change the options while the queue runs (they apply to jobs started from now on; the cap applies at once).
    pub fn set_options(&self, opts: ManagerOptions) {
        self.limit.set_rate(opts.rate_bps);
        if let Ok(mut o) = self.opts.lock() {
            *o = opts;
        }
    }

    /// Whether finished jobs are kept in the history (on unless turned off).
    pub fn history_enabled(&self) -> bool {
        self.store.setting("history").as_deref() != Some("off")
    }

    /// Queue a request. It is planned right away, so a request that cannot run is refused here.
    pub fn add(&self, req: &DownloadRequest, headers: StoredHeaders) -> Result<String> {
        let plan = job::plan(req)?;
        let id = new_id();
        let request = serde_json::to_value(req).map_err(|e| EngineError::invalid(e.to_string()))?;
        let job = create_job(
            &id,
            &request,
            &PlanStages {
                pipeline: plan.pipeline,
                video: plan.video,
                audio: plan.audio,
                requires_ffmpeg: Some(plan.requires_ffmpeg),
            },
            now_ms(),
        );
        self.store.add(&id, &job, &headers)?;
        Ok(id)
    }

    /// Jobs that were running when the previous process ended go back to the queue (they continue from their
    /// checkpoints). Call once, before the queue runs.
    pub fn recover(&self) -> Result<usize> {
        let mut n = 0;
        for j in self.store.jobs()? {
            if vdh_core::queue::is_active(stage_of(&j.job)) {
                self.store.update(&j.id, &requeue(&j.job, false))?;
                n += 1;
            }
        }
        Ok(n)
    }

    fn staging(&self, id: &str) -> PathBuf {
        self.options().staging_dir.join(id)
    }

    fn history(&self, id: &str, job: &Value, path: Option<&str>, bytes: Option<f64>) {
        if !self.history_enabled() {
            return;
        }
        let req = job.get("request").unwrap_or(&Value::Null);
        let source = req
            .get("masterUrl")
            .or_else(|| req.get("sourceUrl"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let _ = self.store.add_history(&HistoryEntry {
            id: id.into(),
            finished_at: now_ms(),
            stage: stage_of(job).into(),
            filename: req
                .get("filename")
                .and_then(Value::as_str)
                .unwrap_or("")
                .into(),
            source: redact_url(source),
            path: path.map(Into::into),
            bytes,
            error: job.get("error").cloned(),
        });
    }

    fn interrupt(&self, id: &str, why: Interrupt) -> bool {
        let Ok(running) = self.running.lock() else {
            return false;
        };
        let Some(r) = running.get(id) else {
            return false;
        };
        if let Ok(mut w) = r.why.lock() {
            *w = Some(why);
        }
        if matches!(why, Interrupt::Pause | Interrupt::Hold) {
            r.paused.store(true, Ordering::SeqCst);
        }
        r.cancel.cancel();
        true
    }

    /// Apply one request to a job.
    async fn apply(&self, j: &StoredJob, control: &str) -> Result<()> {
        let id = j.id.as_str();
        let stage = stage_of(&j.job);
        match control {
            "pause" => {
                if !self.interrupt(id, Interrupt::Pause) && stage == "detected" {
                    self.store.update(id, &requeue(&j.job, true))?;
                }
            }
            "resume" => {
                if stage == "detected" && is_paused(&j.job) {
                    self.store.update(id, &requeue(&j.job, false))?;
                }
            }
            "retry" => {
                if let Ok(next) = retry_job(&j.job, now_ms()) {
                    self.store.clear_checkpoints(id)?;
                    self.store.update(id, &next)?;
                }
            }
            "stop" => {
                if let Some(r) = self.running.lock().ok().as_ref().and_then(|m| m.get(id)) {
                    r.stop.cancel();
                }
            }
            "cancel" => self.cancel(j).await?,
            "remove" => self.remove(id).await?,
            _ => {}
        }
        self.store.clear_request(id)
    }

    /// A running job is interrupted (and ends as cancelled); a waiting one is cancelled here.
    async fn cancel(&self, j: &StoredJob) -> Result<()> {
        if self.interrupt(&j.id, Interrupt::Cancel) {
            return Ok(());
        }
        let Ok(next) = transition(&j.job, "cancelled", now_ms(), None) else {
            return Ok(());
        };
        self.store.clear_checkpoints(&j.id)?;
        let _ = tokio::fs::remove_dir_all(self.staging(&j.id)).await;
        self.store.update(&j.id, &next)?;
        self.history(&j.id, &next, None, None);
        Ok(())
    }

    /// A running job is interrupted (and removed when it stops); a waiting one is removed here, with what it staged.
    async fn remove(&self, id: &str) -> Result<()> {
        if self.interrupt(id, Interrupt::Remove) {
            return Ok(());
        }
        let _ = tokio::fs::remove_dir_all(self.staging(id)).await;
        self.store.remove(id)
    }

    /// Record how a job ended.
    async fn finish(
        &self,
        id: &str,
        live: &Mutex<Live>,
        why: Option<Interrupt>,
        result: Result<job::Finished>,
    ) {
        let job = live.lock().map(|l| l.job.clone()).unwrap_or(Value::Null);
        let now = now_ms();
        let saved = match result {
            Ok(done) => {
                let mut next = transition(&job, "completed", now, None).unwrap_or(job);
                if let Value::Object(m) = &mut next {
                    m.insert(
                        "filePath".into(),
                        done.path.to_string_lossy().into_owned().into(),
                    );
                }
                let path = done.path.to_string_lossy().into_owned();
                self.history(id, &next, Some(&path), Some(done.bytes as f64));
                // a finished job leaves the queue: the history keeps it, without the addresses' tokens
                let _ = self.store.remove(id);
                (self.on_event)(
                    id,
                    &Event::Finished {
                        stage: "completed".into(),
                        path: Some(path),
                        error: None,
                    },
                );
                return;
            }
            Err(e) if e.code == ErrorCode::Paused => requeue(&job, why == Some(Interrupt::Pause)),
            Err(e) if e.is_cancelled() && why == Some(Interrupt::Remove) => {
                let _ = self.store.remove(id);
                return;
            }
            Err(e) if e.is_cancelled() => {
                let next = transition(&job, "cancelled", now, None).unwrap_or(job);
                self.history(id, &next, None, None);
                let _ = self.store.clear_checkpoints(id);
                next
            }
            Err(e) => {
                let error = json!({ "code": e.code.as_str(), "message": e.message });
                let next = vdh_core::queue::fail_job(&job, now, &error);
                self.history(id, &next, None, None);
                let _ = self.store.clear_checkpoints(id);
                next
            }
        };
        let _ = self.store.update(id, &saved);
        (self.on_event)(
            id,
            &Event::Finished {
                stage: stage_of(&saved).into(),
                path: None,
                error: saved
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .map(Into::into),
            },
        );
    }

    fn start(self: &Arc<Self>, j: StoredJob) -> Result<()> {
        let id = j.id.clone();
        let req: DownloadRequest = serde_json::from_value(j.job["request"].clone())
            .map_err(|e| EngineError::invalid(format!("Stored request: {e}")))?;
        let net = Net::new(RequestHeaders {
            referer: j.headers.referer.clone(),
            origin: j.headers.origin.clone(),
            user_agent: j.headers.user_agent.clone(),
            cookies: Vec::new(),
        })?
        .with_limit(self.limit.clone());
        let opts = self.options();
        let cancel = CancellationToken::new();
        let stop = CancellationToken::new();
        let paused = Arc::new(AtomicBool::new(false));
        let why = Arc::new(Mutex::new(None));
        let live = Arc::new(Mutex::new(Live {
            job: j.job.clone(),
            saved: Instant::now(),
        }));
        let events = {
            let (store, live, id, sink) = (
                self.store.clone(),
                live.clone(),
                id.clone(),
                self.on_event.clone(),
            );
            move |e: Event| {
                if let Ok(mut l) = live.lock() {
                    let save = match &e {
                        // the end is recorded by `finish`, with the file
                        Event::Stage { stage } if *stage == "completed" => false,
                        Event::Stage { stage } => {
                            if let Ok(next) = transition(&l.job, stage, now_ms(), None) {
                                l.job = next;
                            }
                            true
                        }
                        Event::Finished { .. } => false,
                        Event::Progress(p) => {
                            let p = serde_json::to_value(p).unwrap_or(Value::Null);
                            l.job = with_progress(&l.job, &p, now_ms());
                            l.saved.elapsed() >= Duration::from_millis(500)
                        }
                    };
                    if save {
                        let _ = store.update(&id, &l.job);
                        l.saved = Instant::now();
                    }
                }
                sink(&id, &e);
            }
        };
        let ctx = JobContext {
            net,
            out_dir: opts.out_dir.clone(),
            work_dir: opts.staging_dir.join(&id),
            concurrency: opts.segment_concurrency.max(1),
            cancel: cancel.clone(),
            stop: stop.clone(),
            paused: paused.clone(),
            checkpoints: Some(Box::new(StoreCheckpoints {
                store: self.store.clone(),
                id: id.clone(),
            })),
            events: Box::new(events),
        };
        let me = self.clone();
        let (task_id, task_why) = (id.clone(), why.clone());
        let handle = tokio::spawn(async move {
            let result = job::run(&req, &ctx).await;
            let why = task_why.lock().ok().and_then(|w| *w);
            me.finish(&task_id, &live, why, result).await;
        });
        if let Ok(mut running) = self.running.lock() {
            running.insert(
                id,
                Running {
                    cancel,
                    stop,
                    paused,
                    why,
                    handle,
                },
            );
        }
        Ok(())
    }

    /// One turn of the queue: apply requests, forget finished jobs, keep the window, start jobs. True when nothing is
    /// running and nothing is waiting to start.
    pub async fn tick(self: &Arc<Self>) -> Result<bool> {
        let jobs = self.store.jobs()?;
        for j in jobs.iter().filter(|j| j.control.is_some()) {
            let control = j.control.clone().unwrap_or_default();
            self.apply(j, &control).await?;
        }
        if let Ok(mut running) = self.running.lock() {
            running.retain(|_, r| !r.handle.is_finished());
        }
        let opts = self.options();
        let open = opts.window.as_ref().is_none_or(Window::allows_now);
        let running: Vec<String> = self
            .running
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        if !open {
            for id in &running {
                self.interrupt(id, Interrupt::Hold);
            }
        }
        let jobs = self.store.jobs()?;
        let waiting: Vec<StoredJob> = jobs
            .into_iter()
            .filter(|j| {
                stage_of(&j.job) == "detected" && !is_paused(&j.job) && !running.contains(&j.id)
            })
            .collect();
        if open {
            let free = opts.max_jobs.max(1).saturating_sub(running.len());
            for j in waiting.iter().take(free) {
                if let Err(e) = self.start(j.clone()) {
                    let failed = vdh_core::queue::fail_job(
                        &j.job,
                        now_ms(),
                        &json!({ "code": e.code.as_str(), "message": e.message }),
                    );
                    self.store.update(&j.id, &failed)?;
                }
            }
        }
        let idle = running.is_empty()
            && waiting.is_empty()
            && self.running.lock().map(|m| m.is_empty()).unwrap_or(true);
        Ok(idle)
    }

    /// Hold every running job (they go back to the queue with what they staged) and wait for them to stop.
    pub async fn hold_all(&self) {
        let ids: Vec<String> = self
            .running
            .lock()
            .map(|m| m.keys().cloned().collect())
            .unwrap_or_default();
        for id in &ids {
            self.interrupt(id, Interrupt::Hold);
        }
        let handles: Vec<JoinHandle<()>> = self
            .running
            .lock()
            .map(|mut m| m.drain().map(|(_, r)| r.handle).collect())
            .unwrap_or_default();
        for h in handles {
            let _ = h.await;
        }
    }

    /// Run the queue: until it is idle (`until_idle`), until `limit` has passed, or until `quit` fires. Jobs still
    /// running then are held: they continue the next time the queue runs.
    pub async fn run(
        self: &Arc<Self>,
        until_idle: bool,
        limit: Option<Duration>,
        quit: CancellationToken,
    ) -> Result<()> {
        self.recover()?;
        let started = Instant::now();
        loop {
            let idle = self.tick().await?;
            if until_idle && idle {
                break;
            }
            if limit.is_some_and(|l| started.elapsed() >= l) {
                break;
            }
            tokio::select! {
                () = quit.cancelled() => break,
                () = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
        }
        self.hold_all().await;
        Ok(())
    }
}
