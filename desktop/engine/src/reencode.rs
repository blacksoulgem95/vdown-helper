//! A re-encode job: a finished download or a local file, re-encoded as the user asked (`vdh-core`'s closed set of
//! encodes), into a new file next to the downloads. The original is never touched. Written to the job's staging
//! folder first and moved into place when complete, like every job.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use vdh_core::transcode::{Encode, build_encode_args, check};

use crate::error::{EngineError, ErrorCode, Result};
use crate::ffmpeg;
use crate::job::{Event, Finished, JobContext, Progress, place, unique_path};

/// What a re-encode job keeps in the queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reencode {
    /// The file to read (never written).
    pub input: String,
    pub encode: Encode,
    /// What the job is called in the queue and in the new file's name (a preset's or the user's own).
    pub label: String,
}

/// The new file's name: the input's, with the label (`clip [H.265].mp4`).
pub fn output_name(input: &Path, label: &str) -> String {
    let stem = input
        .file_stem()
        .map_or_else(|| "video".to_string(), |s| s.to_string_lossy().into_owned());
    format!("{stem} [{label}]")
}

/// Check a re-encode before it is queued: a readable file, and an encode the container can hold.
pub fn validate(r: &Reencode) -> Result<()> {
    check(&r.encode)
        .map_err(|code| EngineError::invalid(format!("Not a possible encode: {code}")))?;
    let input = Path::new(&r.input);
    if !input.is_absolute() || !input.is_file() {
        return Err(EngineError::invalid("The file to re-encode is not there"));
    }
    Ok(())
}

pub async fn run(r: &Reencode, ctx: &JobContext) -> Result<Finished> {
    // checked again when it runs: the file may have gone since it was queued
    validate(r)?;
    tokio::fs::create_dir_all(&ctx.work_dir).await?;
    let result = run_inner(r, ctx).await;
    if result.as_ref().is_err_and(EngineError::is_cancelled) && ctx.paused.load(Ordering::SeqCst) {
        // a paused re-encode starts again from the beginning (ffmpeg cannot continue a half-written file)
        let _ = tokio::fs::remove_dir_all(&ctx.work_dir).await;
        return Err(EngineError::new(ErrorCode::Paused, "Paused"));
    }
    let _ = tokio::fs::remove_dir_all(&ctx.work_dir).await;
    if let Some(parent) = ctx.work_dir.parent() {
        let _ = tokio::fs::remove_dir(parent).await;
    }
    result
}

async fn run_inner(r: &Reencode, ctx: &JobContext) -> Result<Finished> {
    (ctx.events)(Event::Stage { stage: "preparing" });
    let input = PathBuf::from(&r.input);
    let ext = r.encode.container.extension();
    let tmp = ctx.work_dir.join(format!("output.{ext}"));
    let duration = ffmpeg::duration(&input).await;
    let args = build_encode_args(
        &input.to_string_lossy(),
        &tmp.to_string_lossy(),
        &r.encode,
        true,
    )
    .map_err(|code| EngineError::invalid(format!("Not a possible encode: {code}")))?;
    (ctx.events)(Event::Stage { stage: "encoding" });
    let started = std::time::Instant::now();
    ffmpeg::run_args(&args, duration, &ctx.cancel, |f| {
        let elapsed = started.elapsed().as_secs_f64();
        (ctx.events)(Event::Progress(Progress {
            fraction: Some(f),
            elapsed_sec: Some(elapsed),
            eta_seconds: (f > 0.02 && elapsed > 2.0).then(|| elapsed * (1.0 - f) / f),
            ..Progress::default()
        }));
    })
    .await?;
    let bytes = tokio::fs::metadata(&tmp).await?.len();
    if bytes == 0 {
        return Err(EngineError::new(
            ErrorCode::Ffmpeg,
            "ffmpeg wrote an empty file",
        ));
    }
    tokio::fs::create_dir_all(&ctx.out_dir).await?;
    let to = unique_path(&ctx.out_dir, &output_name(&input, &r.label), ext);
    place(&tmp, &to).await?;
    (ctx.events)(Event::Stage { stage: "completed" });
    Ok(Finished { path: to, bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vdh_core::transcode::PRESETS;

    #[test]
    fn the_new_name_keeps_the_original_and_says_how() {
        assert_eq!(
            output_name(Path::new("/d/My clip.mp4"), "H.265"),
            "My clip [H.265]"
        );
        assert_eq!(output_name(Path::new("/d/noext"), "Phone"), "noext [Phone]");
    }

    #[test]
    fn a_missing_or_relative_file_or_an_impossible_encode_is_refused() {
        let r = |input: &str, e: Encode| Reencode {
            input: input.into(),
            encode: e,
            label: "x".into(),
        };
        assert!(validate(&r("relative.mp4", PRESETS[0].encode)).is_err());
        assert!(validate(&r("/nonexistent/clip.mp4", PRESETS[0].encode)).is_err());
        let here = std::env::current_exe().expect("exe");
        assert!(validate(&r(&here.to_string_lossy(), PRESETS[0].encode)).is_ok());
        let mut bad = PRESETS[0].encode;
        bad.quality = vdh_core::transcode::Quality::Crf { value: 99 };
        assert!(validate(&r(&here.to_string_lossy(), bad)).is_err());
    }
}
