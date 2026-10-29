//! One job from start to finish: the request is re-planned and re-checked here (never trusted as sent), its media
//! staged to disk, joined or converted by ffmpeg when the plan says so, and moved to its final name.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tokio_util::sync::CancellationToken;
use vdh_core::compat::{Limits, Plan};
use vdh_core::ffmpeg_args::FfmpegArgsInput;
use vdh_core::queue::{PlanStages, SpeedMeter, stages_for};
use vdh_core::request::{DownloadRequest, plan_from_request};
use vdh_core::security::{sanitize_filename, sanitize_subfolder, with_extension};
use vdh_core::url::is_safe_fetch_url;

use crate::error::{EngineError, ErrorCode, Result};
use crate::net::Net;
use crate::segments::{SegmentOptions, SegmentProgress};
use crate::stage::{Staged, TrackCheckpoint, stage_file, stage_stream};
use crate::{ffmpeg, live};

/// What a running job reports: the stage it entered, or progress within it (the extension's `JobProgress`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Stage {
        stage: &'static str,
    },
    Progress(Progress),
    /// The job needs the browser's cookies for these origins (they are never stored, so after a restart it waits).
    NeedsCookies {
        origins: Vec<String>,
    },
    /// The queue recorded how the job ended (`stage`: completed, failed, cancelled; or detected when held or paused).
    Finished {
        stage: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        bytes: Option<f64>,
        /// The extension's `JobErrorCode` when it failed.
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units_done: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units_total: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_sec: Option<f64>,
}

/// Where a job keeps the checkpoints of its staged tracks (the queue stores them; a one-off run keeps none).
pub trait Checkpoints: Send + Sync {
    fn load(&self, track: &str) -> Option<TrackCheckpoint>;
    fn save(&self, track: &str, checkpoint: &TrackCheckpoint);
}

pub struct JobContext {
    pub net: Net,
    /// Where finished files go (the request's subfolder is created inside).
    pub out_dir: PathBuf,
    /// Staging for this job: partial files, removed when the job ends.
    pub work_dir: PathBuf,
    /// Segments fetched at a time.
    pub concurrency: usize,
    /// Stops the job and discards what it fetched.
    pub cancel: CancellationToken,
    /// Ends a live recording and keeps what was recorded.
    pub stop: CancellationToken,
    /// Set before `cancel` fires when the job is only paused: its staging is kept, and it continues later.
    pub paused: Arc<AtomicBool>,
    pub checkpoints: Option<Box<dyn Checkpoints>>,
    pub events: Box<dyn Fn(Event) + Send + Sync>,
}

impl JobContext {
    fn checkpoint(&self, track: &str) -> Option<TrackCheckpoint> {
        self.checkpoints.as_ref().and_then(|c| c.load(track))
    }

    fn save(&self, track: &str, cp: &TrackCheckpoint) {
        if let Some(c) = &self.checkpoints {
            c.save(track, cp);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Finished {
    pub path: PathBuf,
    pub bytes: u64,
}

/// The desktop app writes to disk, so the extension's memory and encode-time limits do not apply.
pub const NO_LIMITS: Limits = Limits {
    max_memory_mb: f64::INFINITY,
    max_encode_duration_sec: f64::INFINITY,
};

/// The plan for a request, with the reason it cannot run.
pub fn plan(req: &DownloadRequest) -> Result<Plan> {
    for url in std::iter::once(&req.source_url).chain(req.audio_url.as_ref()) {
        let base =
            vdh_core::dash::parse_dash_ref(url).map_or_else(|| url.clone(), |r| r.manifest_url);
        if !is_safe_fetch_url(&base) {
            return Err(EngineError::invalid(
                "Only http(s) addresses can be downloaded",
            ));
        }
    }
    let plan = plan_from_request(req, NO_LIMITS);
    if plan.valid {
        return Ok(plan);
    }
    if plan.issues.iter().any(|i| i == "protected") {
        return Err(EngineError::protected(
            "This stream is protected and cannot be downloaded",
        ));
    }
    Err(EngineError::invalid(format!(
        "This request cannot be fulfilled: {}",
        plan.issues.join(", ")
    )))
}

/// The request's file name (made safe, with the plan's extension) in `dir`, or `name (2).ext`, `name (3).ext`... when
/// that is taken.
pub fn unique_path(dir: &Path, filename: &str, ext: &str) -> PathBuf {
    let name = sanitize_filename(filename, "video", 150);
    let suffix = format!(".{ext}");
    let stem = if name.to_lowercase().ends_with(&suffix.to_lowercase()) {
        &name[..name.len() - suffix.len()]
    } else {
        name.as_str()
    };
    let stem = if stem.is_empty() { "video" } else { stem };
    let mut p = dir.join(with_extension(stem, ext));
    let mut n = 2;
    while p.exists() {
        p = dir.join(with_extension(&format!("{stem} ({n})"), ext));
        n += 1;
    }
    p
}

/// A file moved to its final place (a copy when the staging folder is on another disk).
pub(crate) async fn place(from: &Path, to: &Path) -> Result<()> {
    if tokio::fs::rename(from, to).await.is_err() {
        tokio::fs::copy(from, to).await?;
        tokio::fs::remove_file(from).await?;
    }
    Ok(())
}

struct Reporter<'a> {
    ctx: &'a JobContext,
    meter: SpeedMeter,
    started: std::time::Instant,
}

impl<'a> Reporter<'a> {
    fn new(ctx: &'a JobContext) -> Self {
        Self {
            ctx,
            meter: SpeedMeter::default(),
            started: std::time::Instant::now(),
        }
    }

    fn stage(&mut self, stage: &'static str) {
        (self.ctx.events)(Event::Stage { stage });
        self.meter = SpeedMeter::default();
        self.started = std::time::Instant::now();
    }

    fn bytes(&mut self, done: u64, total: Option<u64>) {
        let now = self.started.elapsed().as_millis() as f64;
        self.meter.update(done as f64, now);
        (self.ctx.events)(Event::Progress(Progress {
            bytes_done: Some(done as f64),
            bytes_total: total.map(|t| t as f64),
            fraction: total
                .filter(|t| *t > 0)
                .map(|t| (done as f64 / t as f64).min(1.0)),
            bytes_per_second: self.meter.bytes_per_second(),
            eta_seconds: self
                .meter
                .eta_seconds(total.map(|t| t.saturating_sub(done) as f64)),
            ..Progress::default()
        }));
    }

    fn segments(&mut self, p: SegmentProgress) {
        let now = self.started.elapsed().as_millis() as f64;
        self.meter.update(p.bytes as f64, now);
        let elapsed = now / 1000.0;
        (self.ctx.events)(Event::Progress(Progress {
            fraction: Some(p.done as f64 / p.total.max(1) as f64),
            units_done: Some(p.done as f64),
            units_total: Some(p.total as f64),
            bytes_done: Some(p.bytes as f64),
            bytes_per_second: self.meter.bytes_per_second(),
            eta_seconds: (p.done >= 3 && elapsed > 2.0)
                .then(|| (p.total - p.done) as f64 * elapsed / p.done as f64),
            ..Progress::default()
        }));
    }

    fn fraction(&self, f: f64) {
        (self.ctx.events)(Event::Progress(Progress {
            fraction: Some(f),
            ..Progress::default()
        }));
    }
}

/// Run one request to the end. The staging folder is removed when the job ends, and kept when it is only paused.
pub async fn run(req: &DownloadRequest, ctx: &JobContext) -> Result<Finished> {
    let plan = plan(req)?;
    tokio::fs::create_dir_all(&ctx.work_dir).await?;
    let result = run_plan(req, &plan, ctx).await;
    if result.as_ref().is_err_and(EngineError::is_cancelled) && ctx.paused.load(Ordering::SeqCst) {
        return Err(EngineError::new(ErrorCode::Paused, "Paused"));
    }
    let _ = tokio::fs::remove_dir_all(&ctx.work_dir).await;
    // the staging root goes too once no other job uses it
    if let Some(parent) = ctx.work_dir.parent() {
        let _ = tokio::fs::remove_dir(parent).await;
    }
    result
}

async fn run_plan(req: &DownloadRequest, plan: &Plan, ctx: &JobContext) -> Result<Finished> {
    let mut rep = Reporter::new(ctx);
    let stages = stages_for(&PlanStages {
        pipeline: plan.pipeline.clone(),
        video: plan.video.clone(),
        audio: plan.audio.clone(),
        requires_ffmpeg: Some(plan.requires_ffmpeg),
    });
    rep.stage("preparing");
    let dir = ctx.out_dir.join(sanitize_subfolder(&req.subfolder));
    tokio::fs::create_dir_all(&dir).await?;
    let out_tmp = ctx.work_dir.join(with_extension("output", &plan.extension));
    let opts = SegmentOptions {
        net: &ctx.net,
        concurrency: ctx.concurrency,
        tolerate_missing: false,
        cancel: &ctx.cancel,
    };
    let streamed = req.is_hls || req.is_dash == Some(true);

    let (video, audio, duration) = if plan.pipeline == "live" {
        rep.stage("recording");
        // a recording interrupted by a restart cannot pick up the time it missed: what it has is joined and kept
        let recorded = ctx.checkpoint("video").filter(|c| c.sink.bytes > 0);
        let rec = match recorded {
            Some(cp) => {
                let audio = ctx.work_dir.join("audio.stream");
                live::Recorded {
                    video: ctx.work_dir.join("video.stream"),
                    audio: req.audio_url.as_ref().map(|_| audio),
                    duration_sec: cp.sink.seconds,
                }
            }
            None => {
                live::record(req, ctx, &mut |p| {
                    ctx.save(
                        "video",
                        &TrackCheckpoint {
                            next: p.done,
                            sink: p.state.clone(),
                            ..TrackCheckpoint::default()
                        },
                    );
                    rep.segments(p);
                })
                .await?
            }
        };
        (rec.video, rec.audio, Some(rec.duration_sec))
    } else if matches!(
        plan.pipeline.as_str(),
        "native" | "hls-concat" | "hls-ffmpeg-copy" | "file-ffmpeg-copy" | "ffmpeg-transcode"
    ) {
        rep.stage("downloading");
        if streamed {
            let dash = req.is_dash == Some(true);
            let v = ctx.work_dir.join("video.stream");
            let from = ctx.checkpoint("video");
            let staged: Staged =
                stage_stream(&opts, &req.source_url, dash, &v, from.as_ref(), |p, cp| {
                    ctx.save("video", cp);
                    rep.segments(p);
                })
                .await?;
            let a = match &req.audio_url {
                Some(url) => {
                    let a = ctx.work_dir.join("audio.stream");
                    let from = ctx.checkpoint("audio");
                    let dash = dash || vdh_core::dash::parse_dash_ref(url).is_some();
                    stage_stream(&opts, url, dash, &a, from.as_ref(), |p, cp| {
                        ctx.save("audio", cp);
                        rep.segments(p);
                    })
                    .await?;
                    Some(a)
                }
                None => None,
            };
            (v, a, Some(staged.duration_sec).filter(|d| *d > 0.0))
        } else {
            let v = ctx.work_dir.join("source.file");
            stage_file(&opts, &req.source_url, &v, |d, t| rep.bytes(d, t)).await?;
            (v, None, req.duration_sec)
        }
    } else {
        return Err(EngineError::invalid(
            "This kind of job is done by the browser extension, not the desktop app",
        ));
    };

    let target = if plan.requires_ffmpeg {
        let stage = if stages.contains(&"encoding") {
            "encoding"
        } else {
            "merging"
        };
        rep.stage(stage);
        let input = FfmpegArgsInput {
            mode: req.mode.clone(),
            extension: plan.extension.clone(),
            video: plan.video.clone(),
            audio: plan.audio.clone(),
            video_path: video.to_string_lossy().into_owned(),
            audio_path: audio.as_ref().map(|a| a.to_string_lossy().into_owned()),
            audio_format: req.audio_format.clone(),
            audio_bitrate: req.audio_bitrate,
            // two live tracks keep their own timestamps, shifted together
            keep_offsets: (plan.pipeline == "live" && audio.is_some()).then_some(true),
            progress: Some(true),
            output: out_tmp.to_string_lossy().into_owned(),
        };
        ffmpeg::run(&input, duration, &ctx.cancel, |f| rep.fraction(f)).await?;
        out_tmp
    } else {
        video
    };
    let final_path = unique_path(&dir, &req.filename, &plan.extension);
    place(&target, &final_path).await?;
    let bytes = tokio::fs::metadata(&final_path).await?.len();
    rep.stage("completed");
    Ok(Finished {
        path: final_path,
        bytes,
    })
}
