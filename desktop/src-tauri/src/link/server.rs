//! The app's end of the link: a local socket the relay connects to, one connection per extension port. Jobs handed
//! over keep the extension's id; the connection is told about the jobs it handed over or asked about (stages, progress
//! a few times a second, the end), and can ask again after it reconnects (`status`).

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use interprocess::local_socket::ListenerOptions;
use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::traits::tokio::Listener as _;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use vdh_engine::manager::Manager;
use vdh_engine::{EngineError, Event};

use super::protocol::{self, Incoming, VERSION};
use super::{frame, prepare_socket_dir, socket_name};

/// Progress is passed on at most this often per job (the extension writes each one to its storage).
const PROGRESS_EVERY: Duration = Duration::from_millis(400);

struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Value>,
    watched: HashSet<String>,
}

pub struct Link {
    manager: Arc<Manager>,
    conns: Mutex<Vec<Conn>>,
    sent: Mutex<HashMap<String, Instant>>,
    ffmpeg: OnceLock<Option<String>>,
}

fn msg(kind: &str, fields: Value) -> Value {
    let mut m = Map::new();
    m.insert("v".into(), VERSION.into());
    m.insert("type".into(), kind.into());
    if let Value::Object(f) = fields {
        m.extend(f);
    }
    Value::Object(m)
}

fn failure(job_id: Option<&str>, e: &EngineError) -> Value {
    msg(
        "error",
        json!({ "jobId": job_id, "code": e.code.as_str(), "message": e.message }),
    )
}

/// The first line of `ffmpeg -version`, or `None` when there is no ffmpeg to run.
fn ffmpeg_version() -> Option<String> {
    let out = std::process::Command::new(vdh_engine::ffmpeg::ffmpeg_program())
        .arg("-version")
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?;
    line.strip_prefix("ffmpeg version ")
        .and_then(|v| v.split_whitespace().next())
        .map(String::from)
}

impl Link {
    pub fn new(manager: Arc<Manager>) -> Arc<Self> {
        Arc::new(Self {
            manager,
            conns: Mutex::new(Vec::new()),
            sent: Mutex::new(HashMap::new()),
            ffmpeg: OnceLock::new(),
        })
    }

    /// Accept the relay's connections until the app quits.
    pub async fn serve(self: Arc<Self>) -> io::Result<()> {
        prepare_socket_dir()?;
        let listener = ListenerOptions::new()
            .name(socket_name()?)
            // a socket left behind by an app that was killed is replaced (one app runs at a time)
            .try_overwrite(true)
            .create_tokio()?;
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            let _ = me.ffmpeg.set(ffmpeg_version());
        });
        let next = AtomicU64::new(1);
        loop {
            let stream = listener.accept().await?;
            let id = next.fetch_add(1, Ordering::Relaxed);
            tokio::spawn(self.clone().connection(id, stream));
        }
    }

    async fn connection(self: Arc<Self>, id: u64, stream: Stream) {
        let stream = Arc::new(stream);
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        if let Ok(mut c) = self.conns.lock() {
            c.push(Conn {
                id,
                tx: tx.clone(),
                watched: HashSet::new(),
            });
        }
        let out = stream.clone();
        let writer = tokio::spawn(async move {
            let mut to = &*out;
            while let Some(m) = rx.recv().await {
                let bytes = serde_json::to_vec(&m).unwrap_or_default();
                if frame::write(&mut to, &bytes).await.is_err() {
                    break;
                }
            }
        });
        let mut from = &*stream;
        while let Ok(Some(bytes)) = frame::read(&mut from).await {
            let replies = match protocol::parse(&bytes) {
                Ok(m) => self.handle(id, m),
                Err(e) => vec![failure(None, &e)],
            };
            for r in replies {
                let _ = tx.send(r);
            }
        }
        if let Ok(mut c) = self.conns.lock() {
            c.retain(|c| c.id != id);
        }
        writer.abort();
    }

    fn watch(&self, conn: u64, job: &str) {
        if let Ok(mut c) = self.conns.lock()
            && let Some(c) = c.iter_mut().find(|c| c.id == conn)
        {
            c.watched.insert(job.to_string());
        }
    }

    fn handle(&self, conn: u64, m: Incoming) -> Vec<Value> {
        match m {
            Incoming::Hello { .. } => vec![msg(
                "hello",
                json!({
                    "appVersion": env!("CARGO_PKG_VERSION"),
                    "ffmpeg": self.ffmpeg.get().cloned().flatten(),
                }),
            )],
            Incoming::RunJob {
                job_id,
                request,
                headers,
                cookies,
                ..
            } => {
                self.watch(conn, &job_id);
                match self.run_job(&job_id, request, headers, cookies) {
                    Ok(stages) => vec![msg(
                        "accepted",
                        json!({ "jobId": job_id, "stages": stages }),
                    )],
                    Err(e) => vec![failure(Some(&job_id), &e)],
                }
            }
            Incoming::Cancel { job_id, .. } => self.control(conn, &job_id, "cancel"),
            Incoming::Pause { job_id, .. } => self.control(conn, &job_id, "pause"),
            Incoming::Resume { job_id, .. } => self.control(conn, &job_id, "resume"),
            Incoming::Stop { job_id, .. } => self.control(conn, &job_id, "stop"),
            Incoming::Cookies {
                job_id, cookies, ..
            } => {
                let granted = self
                    .manager
                    .store()
                    .get(&job_id)
                    .ok()
                    .flatten()
                    .map(|j| j.headers.cookie_origins)
                    .unwrap_or_default();
                self.manager
                    .set_cookies(&job_id, protocol::cookies_for(&granted, cookies));
                Vec::new()
            }
            Incoming::Status { job_ids, .. } => {
                for j in &job_ids {
                    self.watch(conn, j);
                }
                vec![self.status(&job_ids)]
            }
        }
    }

    fn run_job(
        &self,
        job_id: &str,
        request: Value,
        headers: Option<protocol::Headers>,
        cookies: Option<Vec<protocol::CookieSet>>,
    ) -> vdh_engine::Result<Value> {
        let h = protocol::handover(request, headers, cookies)?;
        // handed over again after it failed or was cancelled: the user retried it in the browser
        let ended = self
            .manager
            .store()
            .get(job_id)?
            .is_some_and(|j| matches!(j.job["stage"].as_str(), Some("failed" | "cancelled")));
        if ended {
            self.manager.store().request(job_id, "retry")?;
        }
        // cookies first: the queue must not start the job without them
        if !h.cookies.is_empty() {
            self.manager.set_cookies(job_id, h.cookies);
        }
        if let Err(e) = self.manager.add_with_id(job_id, &h.request, h.headers) {
            self.manager.forget_cookies(job_id);
            return Err(e);
        }
        Ok(self
            .manager
            .store()
            .get(job_id)?
            .map(|j| j.job["stages"].clone())
            .unwrap_or(Value::Null))
    }

    fn control(&self, conn: u64, job_id: &str, action: &str) -> Vec<Value> {
        self.watch(conn, job_id);
        match self.manager.store().request(job_id, action) {
            Ok(true) => Vec::new(),
            Ok(false) => vec![failure(Some(job_id), &EngineError::invalid("No such job"))],
            Err(e) => vec![failure(Some(job_id), &e)],
        }
    }

    /// Where each job is now: in the queue, finished (from the history), or unknown to the app.
    fn status(&self, ids: &[String]) -> Value {
        let store = self.manager.store();
        let history = store.history().unwrap_or_default();
        let jobs: Vec<Value> = ids
            .iter()
            .map(|id| {
                if let Ok(Some(j)) = store.get(id) {
                    return json!({
                        "jobId": id,
                        "stage": j.job["stage"],
                        "paused": j.job["paused"],
                        "progress": j.job["progress"],
                        "stages": j.job["stages"],
                        "error": j.job.get("error"),
                    });
                }
                match history.iter().find(|h| &h.id == id) {
                    Some(h) => json!({
                        "jobId": id,
                        "stage": h.stage,
                        "path": h.path,
                        "bytes": h.bytes,
                        "error": h.error,
                    }),
                    None => json!({ "jobId": id, "stage": "gone" }),
                }
            })
            .collect();
        msg("status", json!({ "jobs": jobs }))
    }

    fn send(&self, job: &str, m: &Value) {
        if let Ok(c) = self.conns.lock() {
            for c in c.iter().filter(|c| c.watched.contains(job)) {
                let _ = c.tx.send(m.clone());
            }
        }
    }

    /// An event from the queue: passed on to the connections that follow this job.
    pub fn event(&self, id: &str, e: &Event) {
        let m = match e {
            // the end is reported once the queue recorded it, with the file (`Finished`)
            Event::Stage { stage } if matches!(*stage, "completed" | "failed" | "cancelled") => {
                return;
            }
            Event::Stage { stage } => msg("stage", json!({ "jobId": id, "stage": stage })),
            Event::Progress(p) => {
                let due = self.sent.lock().is_ok_and(|mut s| {
                    let now = Instant::now();
                    let due = s
                        .get(id)
                        .is_none_or(|t| now.duration_since(*t) >= PROGRESS_EVERY);
                    if due {
                        s.insert(id.to_string(), now);
                    }
                    due
                });
                if !due {
                    return;
                }
                msg("progress", json!({ "jobId": id, "progress": p }))
            }
            Event::NeedsCookies { origins } => {
                msg("needs-cookies", json!({ "jobId": id, "origins": origins }))
            }
            Event::Finished {
                stage,
                path,
                bytes,
                code,
                error,
            } => {
                if let Ok(mut s) = self.sent.lock() {
                    s.remove(id);
                }
                match stage.as_str() {
                    "completed" => {
                        msg("done", json!({ "jobId": id, "path": path, "bytes": bytes }))
                    }
                    "failed" => msg(
                        "error",
                        json!({ "jobId": id, "code": code.as_deref().unwrap_or("unknown"), "message": error }),
                    ),
                    "cancelled" => msg("cancelled", json!({ "jobId": id })),
                    // paused, or back in the queue for the schedule window
                    _ => self.status(&[id.to_string()]),
                }
            }
        };
        self.send(id, &m);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use vdh_engine::Progress;
    use vdh_engine::manager::ManagerOptions;
    use vdh_engine::store::Store;

    fn link() -> Arc<Link> {
        let store = Arc::new(Store::in_memory().expect("store"));
        let opts = ManagerOptions::new(PathBuf::from("/tmp/out"), PathBuf::from("/tmp/staging"));
        Link::new(Arc::new(Manager::new(store, opts, Arc::new(|_, _| {}))))
    }

    /// A connection without a socket: what the app sends it arrives on the receiver.
    fn conn(l: &Link, id: u64) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        l.conns.lock().expect("conns").push(Conn {
            id,
            tx,
            watched: HashSet::new(),
        });
        rx
    }

    fn run_job(id: &str, extra: Value) -> Incoming {
        let mut request = json!({
            "resourceId": "r1",
            "sourceUrl": "https://cdn.example/clip.mp4",
            "tabId": 3,
            "pageUrl": "https://site.example/watch",
            "host": "site.example",
            "mode": "original",
            "container": "original",
            "audioFormat": "mp3",
            "audioBitrate": 192,
            "filename": "Clip.mp4",
            "subfolder": "",
            "qualityLabel": "720p",
            "sourceFormat": "mp4",
            "isHls": false,
            "hasMuxedAudio": true,
            "hasVideo": true
        });
        if let (Value::Object(r), Value::Object(e)) = (&mut request, extra) {
            r.extend(e);
        }
        protocol::parse(
            json!({ "v": 1, "type": "run-job", "jobId": id, "request": request })
                .to_string()
                .as_bytes(),
        )
        .expect("message")
    }

    #[test]
    fn a_handed_over_job_is_queued_under_the_extensions_id() {
        let l = link();
        let replies = l.handle(1, run_job("ext-1", json!({})));
        assert_eq!(replies[0]["type"], "accepted", "{replies:?}");
        assert_eq!(replies[0]["jobId"], "ext-1");
        assert!(
            replies[0]["stages"]
                .as_array()
                .is_some_and(|s| !s.is_empty())
        );
        // handing it over again (the extension reconnected) changes nothing
        assert_eq!(
            l.handle(1, run_job("ext-1", json!({})))[0]["type"],
            "accepted"
        );
        assert_eq!(l.manager.store().jobs().expect("jobs").len(), 1);
        let status = l.status(&["ext-1".into(), "nope".into()]);
        assert_eq!(status["jobs"][0]["stage"], "detected");
        assert_eq!(status["jobs"][1]["stage"], "gone");
    }

    #[test]
    fn forged_jobs_and_unknown_jobs_are_refused() {
        let l = link();
        let r = l.handle(1, run_job("ext-2", json!({ "held": { "kind": "blob" } })));
        assert_eq!(r[0]["type"], "error");
        assert_eq!(r[0]["code"], "invalid");
        let r = l.handle(1, run_job("bad id!", json!({})));
        assert_eq!(r[0]["type"], "error");
        let cancel = protocol::parse(br#"{"v":1,"type":"cancel","jobId":"missing"}"#).expect("msg");
        assert_eq!(l.handle(1, cancel)[0]["type"], "error");
        assert!(l.manager.store().jobs().expect("jobs").is_empty());
    }

    #[test]
    fn events_reach_only_the_connections_that_follow_the_job() {
        let l = link();
        let mut a = conn(&l, 1);
        let mut b = conn(&l, 2);
        l.handle(1, run_job("ext-3", json!({})));
        l.event(
            "ext-3",
            &Event::Stage {
                stage: "downloading",
            },
        );
        assert_eq!(a.try_recv().expect("stage")["stage"], "downloading");
        // the end comes once, with the file (below), never as a bare stage
        l.event("ext-3", &Event::Stage { stage: "completed" });
        assert!(
            a.try_recv().is_err(),
            "a bare completed stage was passed on"
        );
        assert!(
            b.try_recv().is_err(),
            "a connection that did not ask was told"
        );
        // progress is passed on a few times a second, not on every segment
        let p = Event::Progress(Progress {
            fraction: Some(0.5),
            ..Progress::default()
        });
        l.event("ext-3", &p);
        l.event("ext-3", &p);
        assert_eq!(a.try_recv().expect("progress")["type"], "progress");
        assert!(a.try_recv().is_err(), "progress was not throttled");
        l.event(
            "ext-3",
            &Event::Finished {
                stage: "completed".into(),
                path: Some("/tmp/out/Clip.mp4".into()),
                bytes: Some(10.0),
                code: None,
                error: None,
            },
        );
        let done = a.try_recv().expect("done");
        assert_eq!(done["type"], "done");
        assert_eq!(done["path"], "/tmp/out/Clip.mp4");
        assert_eq!(done["v"], 1);
    }
}
