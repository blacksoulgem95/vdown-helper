//! `vdh`: the desktop engine from a terminal (and the integration tests). Prints one JSON line with the result.
//!
//!   vdh probe <url>                       what the address is and the request it would make
//!   vdh get <url> [-o DIR] [options]      download it (a live stream is recorded until it ends or Ctrl+C)
//!   vdh run <request.json|-> [-o DIR]     run a request as the extension would hand it over
//!
//! Ctrl+C once stops a recording and keeps it; twice cancels. Exit codes: 0 done, 1 failed, 2 protected, 3 cancelled.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use vdh_core::request::DownloadRequest;
use vdh_core::settings::Settings;
use vdh_engine::probe::{Wanted, probe};
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
    },
    Run {
        /// A DownloadRequest as JSON, or `-` for stdin.
        request: String,
        #[command(flatten)]
        net: Network,
        #[command(flatten)]
        output: Output,
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
        events: Box::new(move |e| {
            if events {
                eprintln!("{}", serde_json::to_string(&e).unwrap_or_default());
            }
        }),
    };
    let done = run(&req, &ctx).await?;
    Ok(json!({ "ok": true, "path": done.path, "bytes": done.bytes }))
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
            mode,
            container,
            audio_format,
            audio_bitrate,
            variant,
            name,
        } => {
            let wanted = Wanted {
                mode,
                container,
                audio_format,
                audio_bitrate,
                variant,
                filename: name,
            };
            match Net::new(headers(&net)) {
                Ok(n) => match probe(&n, &url, &settings, &wanted).await {
                    Ok(p) => execute(p.request, n, &output).await,
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            }
        }
        Command::Run {
            request,
            net,
            output,
        } => {
            let text = if request == "-" {
                std::io::read_to_string(std::io::stdin()).map_err(EngineError::from)
            } else {
                std::fs::read_to_string(&request).map_err(EngineError::from)
            };
            let req = text.and_then(|t| {
                serde_json::from_str::<DownloadRequest>(&t)
                    .map_err(|e| EngineError::invalid(format!("Not a download request: {e}")))
            });
            match (req, Net::new(headers(&net))) {
                (Ok(r), Ok(n)) => execute(r, n, &output).await,
                (Err(e), _) | (_, Err(e)) => Err(e),
            }
        }
    };
    match result {
        Ok(v) => {
            println!("{v}");
            ExitCode::SUCCESS
        }
        Err(e) => fail(&e),
    }
}
