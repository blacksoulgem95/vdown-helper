//! `vdh`: the desktop engine from a terminal (and the integration tests). Prints one JSON line with the result.
//!
//!   vdh probe <url>                       what the address is and the request it would make
//!   vdh get <url> [-o DIR] [options]      download it (a live stream is recorded until it ends or Ctrl+C)
//!   vdh run <request.json|-> [-o DIR]     run a request as the extension would hand it over
//!   vdh queue add|add-request|list|run|pause|resume|retry|cancel|stop|remove ...   the persistent queue (SQLite)
//!   vdh history [--clear] [--off|--on]    finished jobs (addresses without credentials or tokens)
//!
//! Ctrl+C once stops a recording and keeps it; twice cancels. A running queue holds its jobs on Ctrl+C: they continue
//! the next time it runs. Exit codes: 0 done, 1 failed, 2 protected, 3 cancelled.

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::{Args, Parser, Subcommand};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use vdh_core::request::DownloadRequest;
use vdh_core::settings::Settings;
use vdh_engine::manager::{Manager, ManagerOptions};
use vdh_engine::probe::{Wanted, probe};
use vdh_engine::schedule::Window;
use vdh_engine::store::{Store, StoredHeaders};
use vdh_engine::{EngineError, ErrorCode, JobContext, Net, RequestHeaders, run};

#[derive(Parser)]
#[command(name = "vdh", version, about = "vdown-helper's download engine")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args, Clone)]
struct Network {
    /// Referer to send (only what the browser itself would have sent).
    #[arg(long)]
    referer: Option<String>,
    /// Origin to send.
    #[arg(long)]
    origin: Option<String>,
    /// User-Agent to send instead of the generic one.
    #[arg(long)]
    user_agent: Option<String>,
}

#[derive(Args)]
struct Output {
    /// Folder for the finished file.
    #[arg(short, long, default_value = ".")]
    out: PathBuf,
    /// Segments fetched at a time.
    #[arg(long, default_value_t = 4)]
    concurrency: usize,
    /// Print progress events as JSON lines on stderr.
    #[arg(long)]
    events: bool,
}

#[derive(Args, Clone, Default)]
struct Choose {
    /// video-audio, audio-only, video-only or original.
    #[arg(long)]
    mode: Option<String>,
    /// mp4, mkv, ts or original.
    #[arg(long)]
    container: Option<String>,
    /// mp3, m4a, aac or wav (audio-only).
    #[arg(long)]
    audio_format: Option<String>,
    #[arg(long)]
    audio_bitrate: Option<f64>,
    /// Index of the quality in the master playlist (see `vdh probe`).
    #[arg(long)]
    variant: Option<i64>,
    /// File name (without extension) instead of the naming template.
    #[arg(long)]
    name: Option<String>,
}

impl Choose {
    fn wanted(&self) -> Wanted {
        Wanted {
            mode: self.mode.clone(),
            container: self.container.clone(),
            audio_format: self.audio_format.clone(),
            audio_bitrate: self.audio_bitrate,
            variant: self.variant,
            filename: self.name.clone(),
        }
    }
}

#[derive(Args)]
struct Db {
    /// The queue's database.
    #[arg(long, global = true, default_value = "vdh-queue.db")]
    db: PathBuf,
}

#[derive(Subcommand)]
enum QueueCommand {
    /// Queue an address (probed now, downloaded when the queue runs).
    Add {
        url: String,
        #[command(flatten)]
        net: Network,
        #[command(flatten)]
        choose: Choose,
    },
    /// Queue a request as the extension would hand it over.
    AddRequest {
        request: String,
        #[command(flatten)]
        net: Network,
    },
    /// The queued jobs, in order.
    List,
    /// Run the queue.
    Run {
        /// Folder for finished files.
        #[arg(short, long, default_value = ".")]
        out: PathBuf,
        /// Jobs at a time.
        #[arg(long, default_value_t = 3)]
        max_jobs: usize,
        /// Segments at a time, per job.
        #[arg(long, default_value_t = 4)]
        segments: usize,
        /// Bandwidth cap for all jobs together, in KB/s.
        #[arg(long)]
        rate_kbps: Option<u64>,
        /// When jobs may run (local time), e.g. "Mon-Fri 22:00-06:00".
        #[arg(long)]
        window: Option<String>,
        /// Return once nothing is running or waiting.
        #[arg(long)]
        until_idle: bool,
        /// Return after this many seconds (running jobs are held and continue next time).
        #[arg(long = "for")]
        for_secs: Option<u64>,
        /// Print events as JSON lines on stderr.
        #[arg(long)]
        events: bool,
    },
    Pause {
        id: String,
    },
    Resume {
        id: String,
    },
    Retry {
        id: String,
    },
    Cancel {
        id: String,
    },
    /// End a live recording and keep it.
    Stop {
        id: String,
    },
    Remove {
        id: String,
    },
}

#[derive(Subcommand)]
enum Command {
    Probe {
        url: String,
        #[command(flatten)]
        net: Network,
    },
    Get {
        url: String,
        #[command(flatten)]
        net: Network,
        #[command(flatten)]
        output: Output,
        #[command(flatten)]
        choose: Choose,
    },
    Run {
        /// A DownloadRequest as JSON, or `-` for stdin.
        request: String,
        #[command(flatten)]
        net: Network,
        #[command(flatten)]
        output: Output,
    },
    /// The persistent queue.
    Queue {
        #[command(flatten)]
        db: Db,
        #[command(subcommand)]
        command: QueueCommand,
    },
    /// Finished jobs.
    History {
        #[command(flatten)]
        db: Db,
        /// Forget every finished job.
        #[arg(long)]
        clear: bool,
        /// Stop keeping a history.
        #[arg(long)]
        off: bool,
        /// Keep a history again.
        #[arg(long)]
        on: bool,
    },
}

fn headers(n: &Network) -> RequestHeaders {
    RequestHeaders {
        referer: n.referer.clone(),
        origin: n.origin.clone(),
        user_agent: n.user_agent.clone(),
        cookies: Vec::new(),
    }
}

fn fail(e: &EngineError) -> ExitCode {
    println!(
        "{}",
        json!({ "ok": false, "code": e.code.as_str(), "message": e.message })
    );
    ExitCode::from(match e.code {
        ErrorCode::Protected => 2,
        ErrorCode::Cancelled => 3,
        _ => 1,
    })
}

async fn execute(
    req: DownloadRequest,
    net: Net,
    output: &Output,
) -> Result<serde_json::Value, EngineError> {
    let stop = CancellationToken::new();
    let cancel = CancellationToken::new();
    let (s, c) = (stop.clone(), cancel.clone());
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            s.cancel();
            eprintln!("vdh: stopping (Ctrl+C again cancels)");
            if tokio::signal::ctrl_c().await.is_ok() {
                c.cancel();
            }
        }
    });
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let events = output.events;
    let ctx = JobContext {
        net,
        work_dir: output.out.join(".vdh-partial").join(format!(
            "{}-{}-{stamp}",
            req.resource_id,
            std::process::id()
        )),
        out_dir: output.out.clone(),
        concurrency: output.concurrency.max(1),
        cancel,
        stop,
        paused: std::sync::Arc::default(),
        checkpoints: None,
        events: Box::new(move |e| {
            if events {
                eprintln!("{}", serde_json::to_string(&e).unwrap_or_default());
            }
        }),
    };
    let done = run(&req, &ctx).await?;
    Ok(json!({ "ok": true, "path": done.path, "bytes": done.bytes }))
}

fn stored(n: &Network) -> StoredHeaders {
    StoredHeaders {
        referer: n.referer.clone(),
        origin: n.origin.clone(),
        user_agent: n.user_agent.clone(),
        cookie_origins: Vec::new(),
    }
}

fn read_request(path: &str) -> Result<DownloadRequest, EngineError> {
    let text = if path == "-" {
        std::io::read_to_string(std::io::stdin()).map_err(EngineError::from)?
    } else {
        std::fs::read_to_string(path).map_err(EngineError::from)?
    };
    serde_json::from_str(&text)
        .map_err(|e| EngineError::invalid(format!("Not a download request: {e}")))
}

fn staging_for(db: &Path) -> PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push(".staging");
    PathBuf::from(s)
}

async fn queue(
    db: &Path,
    command: QueueCommand,
    settings: &Settings,
) -> Result<serde_json::Value, EngineError> {
    let store = Arc::new(Store::open(db)?);
    let control = |id: &str, what: &str| -> Result<serde_json::Value, EngineError> {
        if store.request(id, what)? {
            Ok(json!({ "ok": true, "id": id, "requested": what }))
        } else {
            Err(EngineError::invalid("No such job"))
        }
    };
    match command {
        QueueCommand::Add { url, net, choose } => {
            let n = Net::new(headers(&net))?;
            let probed = probe(&n, &url, settings, &choose.wanted()).await?;
            let m = Manager::new(
                store.clone(),
                ManagerOptions::new(".".into(), staging_for(db)),
                Arc::new(|_, _| {}),
            );
            let id = m.add(&probed.request, stored(&net))?;
            Ok(json!({ "ok": true, "id": id }))
        }
        QueueCommand::AddRequest { request, net } => {
            let req = read_request(&request)?;
            let m = Manager::new(
                store.clone(),
                ManagerOptions::new(".".into(), staging_for(db)),
                Arc::new(|_, _| {}),
            );
            let id = m.add(&req, stored(&net))?;
            Ok(json!({ "ok": true, "id": id }))
        }
        QueueCommand::List => {
            let jobs: Vec<serde_json::Value> = store
                .jobs()?
                .into_iter()
                .map(|j| {
                    json!({
                        "id": j.id,
                        "stage": j.job["stage"],
                        "paused": j.job["paused"],
                        "progress": j.job["progress"],
                        "error": j.job.get("error"),
                        "filename": j.job["request"]["filename"],
                        "request": j.control,
                    })
                })
                .collect();
            Ok(json!(jobs))
        }
        QueueCommand::Run {
            out,
            max_jobs,
            segments,
            rate_kbps,
            window,
            until_idle,
            for_secs,
            events,
        } => {
            let window = window.as_deref().map(Window::parse).transpose()?;
            let opts = ManagerOptions {
                max_jobs,
                segment_concurrency: segments,
                rate_bps: rate_kbps.unwrap_or(0) * 1024,
                window,
                ..ManagerOptions::new(out, staging_for(db))
            };
            let sink: vdh_engine::manager::EventSink = Arc::new(move |id, e| {
                if events {
                    eprintln!("{}", json!({ "id": id, "event": e }));
                }
            });
            let m = Arc::new(Manager::new(store.clone(), opts, sink));
            let quit = CancellationToken::new();
            let q = quit.clone();
            tokio::spawn(async move {
                if tokio::signal::ctrl_c().await.is_ok() {
                    q.cancel();
                }
            });
            m.run(until_idle, for_secs.map(Duration::from_secs), quit)
                .await?;
            let left = store.jobs()?.len();
            Ok(json!({ "ok": true, "queued": left }))
        }
        QueueCommand::Pause { id } => control(&id, "pause"),
        QueueCommand::Resume { id } => control(&id, "resume"),
        QueueCommand::Retry { id } => control(&id, "retry"),
        QueueCommand::Cancel { id } => control(&id, "cancel"),
        QueueCommand::Stop { id } => control(&id, "stop"),
        QueueCommand::Remove { id } => control(&id, "remove"),
    }
}

fn history(db: &Path, clear: bool, off: bool, on: bool) -> Result<serde_json::Value, EngineError> {
    let store = Store::open(db)?;
    if clear {
        store.clear_history()?;
    }
    if off {
        store.set_setting("history", "off")?;
    }
    if on {
        store.set_setting("history", "on")?;
    }
    Ok(json!(store.history()?))
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let settings = Settings::default();
    let result = match cli.command {
        Command::Probe { url, net } => match Net::new(headers(&net)) {
            Ok(n) => probe(&n, &url, &settings, &Wanted::default())
                .await
                .map(|p| serde_json::to_value(p).unwrap_or_default()),
            Err(e) => Err(e),
        },
        Command::Get {
            url,
            net,
            output,
            choose,
        } => {
            let wanted = choose.wanted();
            match Net::new(headers(&net)) {
                Ok(n) => match probe(&n, &url, &settings, &wanted).await {
                    Ok(p) => execute(p.request, n, &output).await,
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            }
        }
        Command::Queue { db, command } => queue(&db.db, command, &settings).await,
        Command::History { db, clear, off, on } => history(&db.db, clear, off, on),
        Command::Run {
            request,
            net,
            output,
        } => match (read_request(&request), Net::new(headers(&net))) {
            (Ok(r), Ok(n)) => execute(r, n, &output).await,
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
    };
    match result {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}
