//! ffmpeg as a separate program. Its argument vector comes only from `vdh-core` (never a shell, never a string the page
//! or the user typed); progress is read from `-progress pipe:1`.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use vdh_core::ffmpeg_args::{FfmpegArgsInput, build_ffmpeg_args};

use crate::error::{EngineError, ErrorCode, Result};

/// The ffmpeg to run: `VDH_FFMPEG` when set (the app points it at its bundled copy), otherwise `ffmpeg` on the PATH.
pub fn ffmpeg_program() -> PathBuf {
    std::env::var_os("VDH_FFMPEG").map_or_else(|| PathBuf::from("ffmpeg"), PathBuf::from)
}

/// The last lines ffmpeg wrote to stderr: what went wrong, without the whole log.
fn tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(4)..].join(" | ")
}

/// The ffprobe next to the ffmpeg in use: `VDH_FFPROBE`, else beside `VDH_FFMPEG`, else `ffprobe` on the PATH.
pub fn ffprobe_program() -> PathBuf {
    if let Some(p) = std::env::var_os("VDH_FFPROBE") {
        return PathBuf::from(p);
    }
    let ffmpeg = ffmpeg_program();
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    match ffmpeg.parent().filter(|d| !d.as_os_str().is_empty()) {
        Some(dir) => dir.join(name),
        None => PathBuf::from(name),
    }
}

/// A file's duration in seconds, from ffprobe (`None` when it cannot tell).
pub async fn duration(path: &std::path::Path) -> Option<f64> {
    let out = Command::new(ffprobe_program())
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|d| d.is_finite() && *d > 0.0)
}

/// Run one ffmpeg operation. `duration_sec` turns its progress into a fraction.
pub async fn run(
    input: &FfmpegArgsInput,
    duration_sec: Option<f64>,
    cancel: &CancellationToken,
    on_fraction: impl FnMut(f64),
) -> Result<()> {
    let mut input = input.clone();
    input.progress = Some(true);
    run_args(
        &build_ffmpeg_args(&input),
        duration_sec,
        cancel,
        on_fraction,
    )
    .await
}

/// Run ffmpeg with an argument vector `vdh-core` built (with `-progress pipe:1` in it).
pub async fn run_args(
    args: &[String],
    duration_sec: Option<f64>,
    cancel: &CancellationToken,
    mut on_fraction: impl FnMut(f64),
) -> Result<()> {
    let mut child = Command::new(ffmpeg_program())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            EngineError::new(
                ErrorCode::Ffmpeg,
                format!("ffmpeg could not be started: {e}"),
            )
        })?;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let err_text = tokio::spawn(async move {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.read_to_string(&mut s).await;
        }
        s
    });
    if let Some(out) = stdout {
        let mut lines = BufReader::new(out).lines();
        loop {
            let line = tokio::select! {
                () = cancel.cancelled() => {
                    let _ = child.kill().await;
                    return Err(EngineError::cancelled());
                }
                l = lines.next_line() => l,
            };
            let Ok(Some(line)) = line else { break };
            // out_time_us (microseconds; older builds call it out_time_ms but also mean microseconds)
            let us = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
                .and_then(|v| v.trim().parse::<f64>().ok());
            if let (Some(us), Some(d)) = (us, duration_sec.filter(|d| *d > 0.0)) {
                on_fraction((us / 1e6 / d).clamp(0.0, 1.0));
            }
        }
    }
    let status = tokio::select! {
        () = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err(EngineError::cancelled());
        }
        s = child.wait() => s?,
    };
    let stderr = err_text.await.unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        Err(EngineError::new(
            ErrorCode::Ffmpeg,
            format!("ffmpeg failed: {}", tail(&stderr)),
        ))
    }
}
