//! The queue's SQLite database: jobs (the extension's `DownloadJob` shape, advanced by `vdh-core`'s state machine),
//! the checkpoints of their staged tracks, requests to pause or cancel them (so another process, such as `vdh queue
//! pause`, can reach a running queue), the history of finished jobs and a few settings.
//!
//! Cookies are never stored. The history keeps addresses with credentials and token-like parameters removed.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{EngineError, ErrorCode, Result};
use crate::stage::TrackCheckpoint;

fn db(e: &rusqlite::Error) -> EngineError {
    EngineError::new(ErrorCode::Unknown, format!("Queue database: {e}"))
}

/// What a stored job sends with its requests (cookies are never stored: a job that needs them asks the browser again).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredHeaders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub referer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredJob {
    pub id: String,
    /// The job (`DownloadJob`): request, stage, progress, error...
    pub job: Value,
    pub headers: StoredHeaders,
    /// A request waiting to be applied: pause, resume, retry, cancel, stop or remove.
    pub control: Option<String>,
}

/// A finished job as the history keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub finished_at: f64,
    pub stage: String,
    pub filename: String,
    /// The address, with credentials and tokens removed.
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

pub struct Store {
    conn: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  job TEXT NOT NULL,
  headers TEXT NOT NULL,
  control TEXT
);
CREATE TABLE IF NOT EXISTS checkpoints (
  job_id TEXT NOT NULL,
  track TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (job_id, track)
);
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  finished_at REAL NOT NULL,
  entry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(|e| db(&e))?;
        Self::init(conn)
    }

    /// A database that lives only as long as this value (tests).
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(|e| db(&e))?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // WAL: the running queue and a `vdh queue ...` command can use the file at the same time
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| db(&e))?;
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| db(&e))?;
        conn.execute_batch(SCHEMA).map_err(|e| db(&e))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EngineError::new(ErrorCode::Unknown, "Queue database: lock poisoned"))?;
        f(&conn).map_err(|e| db(&e))
    }

    pub fn add(&self, id: &str, job: &Value, headers: &StoredHeaders) -> Result<()> {
        let headers = serde_json::to_string(headers).unwrap_or_default();
        self.with(|c| {
            c.execute(
                "INSERT INTO jobs (id, position, job, headers) \
                 VALUES (?1, COALESCE((SELECT MAX(position) FROM jobs), 0) + 1, ?2, ?3)",
                params![id, job.to_string(), headers],
            )
            .map(|_| ())
        })
    }

    fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredJob> {
        let job: String = r.get(1)?;
        let headers: String = r.get(2)?;
        Ok(StoredJob {
            id: r.get(0)?,
            job: serde_json::from_str(&job).unwrap_or(Value::Null),
            headers: serde_json::from_str(&headers).unwrap_or_default(),
            control: r.get(3)?,
        })
    }

    /// Every job, in queue order.
    pub fn jobs(&self) -> Result<Vec<StoredJob>> {
        self.with(|c| {
            let mut st =
                c.prepare("SELECT id, job, headers, control FROM jobs ORDER BY position")?;
            let rows = st.query_map([], Self::row)?;
            rows.collect()
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<StoredJob>> {
        self.with(|c| {
            c.query_row(
                "SELECT id, job, headers, control FROM jobs WHERE id = ?1",
                [id],
                Self::row,
            )
            .optional()
        })
    }

    pub fn update(&self, id: &str, job: &Value) -> Result<()> {
        self.with(|c| {
            c.execute(
                "UPDATE jobs SET job = ?2 WHERE id = ?1",
                params![id, job.to_string()],
            )
            .map(|_| ())
        })
    }

    /// Ask the running queue to pause, resume, retry, cancel, stop or remove a job. False when there is no such job.
    pub fn request(&self, id: &str, control: &str) -> Result<bool> {
        self.with(|c| {
            c.execute(
                "UPDATE jobs SET control = ?2 WHERE id = ?1",
                params![id, control],
            )
            .map(|n| n > 0)
        })
    }

    pub fn clear_request(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("UPDATE jobs SET control = NULL WHERE id = ?1", [id])
                .map(|_| ())
        })
    }

    pub fn remove(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM jobs WHERE id = ?1", [id])?;
            c.execute("DELETE FROM checkpoints WHERE job_id = ?1", [id])
                .map(|_| ())
        })
    }

    pub fn checkpoint(&self, id: &str, track: &str) -> Option<TrackCheckpoint> {
        self.with(|c| {
            c.query_row(
                "SELECT data FROM checkpoints WHERE job_id = ?1 AND track = ?2",
                [id, track],
                |r| r.get::<_, String>(0),
            )
            .optional()
        })
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
    }

    pub fn save_checkpoint(&self, id: &str, track: &str, cp: &TrackCheckpoint) -> Result<()> {
        let data = serde_json::to_string(cp).unwrap_or_default();
        self.with(|c| {
            c.execute(
                "INSERT INTO checkpoints (job_id, track, data) VALUES (?1, ?2, ?3) \
                 ON CONFLICT (job_id, track) DO UPDATE SET data = excluded.data",
                params![id, track, data],
            )
            .map(|_| ())
        })
    }

    pub fn clear_checkpoints(&self, id: &str) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM checkpoints WHERE job_id = ?1", [id])
                .map(|_| ())
        })
    }

    pub fn add_history(&self, e: &HistoryEntry) -> Result<()> {
        let entry = serde_json::to_string(e).unwrap_or_default();
        self.with(|c| {
            c.execute(
                "INSERT INTO history (id, finished_at, entry) VALUES (?1, ?2, ?3) \
                 ON CONFLICT (id) DO UPDATE SET finished_at = excluded.finished_at, entry = excluded.entry",
                params![e.id, e.finished_at, entry],
            )
            .map(|_| ())
        })
    }

    /// The history, newest first.
    pub fn history(&self) -> Result<Vec<HistoryEntry>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT entry FROM history ORDER BY finished_at DESC")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.map(|r| r.map(|s| serde_json::from_str(&s).ok()))
                .filter_map(|r| r.transpose())
                .collect()
        })
    }

    pub fn clear_history(&self) -> Result<()> {
        self.with(|c| c.execute("DELETE FROM history", []).map(|_| ()))
    }

    pub fn setting(&self, key: &str) -> Option<String> {
        self.with(|c| {
            c.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
        })
        .ok()
        .flatten()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.with(|c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn jobs_keep_their_order_and_requests() {
        let s = Store::in_memory().expect("db");
        for id in ["a", "b", "c"] {
            s.add(
                id,
                &json!({"id": id, "stage": "detected"}),
                &StoredHeaders::default(),
            )
            .expect("add");
        }
        assert!(s.request("b", "pause").expect("request"));
        assert!(!s.request("zz", "pause").expect("request"));
        let jobs = s.jobs().expect("jobs");
        assert_eq!(
            jobs.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!(jobs[1].control.as_deref(), Some("pause"));
        s.remove("a").expect("remove");
        assert_eq!(s.jobs().expect("jobs").len(), 2);
    }

    #[test]
    fn checkpoints_and_history() {
        let s = Store::in_memory().expect("db");
        let cp = TrackCheckpoint {
            next: 3,
            ..TrackCheckpoint::default()
        };
        s.save_checkpoint("a", "video", &cp).expect("save");
        assert_eq!(s.checkpoint("a", "video"), Some(cp));
        s.clear_checkpoints("a").expect("clear");
        assert_eq!(s.checkpoint("a", "video"), None);
        let e = HistoryEntry {
            id: "a".into(),
            finished_at: 1.0,
            stage: "completed".into(),
            filename: "x.mp4".into(),
            source: "https://a.example/x".into(),
            path: None,
            bytes: Some(5.0),
            error: None,
        };
        s.add_history(&e).expect("history");
        assert_eq!(s.history().expect("history"), [e]);
        s.clear_history().expect("clear");
        assert!(s.history().expect("history").is_empty());
    }
}
