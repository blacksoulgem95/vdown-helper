//! Re-encoding from the window: the presets, the encoders that work on this machine, and queueing re-encodes of files
//! the user chose. Only files the queue finished or the user picked in the file dialog can be re-encoded, and the encode
//! is checked here (`vdh-core`) whatever the window sends. The originals are never written.

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt as _;
use tokio::sync::OnceCell;
use vdh_core::transcode::{Encode, PRESETS, Preset, check, label};
use vdh_engine::encoders::{Encoders, detect};
use vdh_engine::reencode::{Reencode, validate};
use vdh_engine::{EngineError, Result};

use crate::commands::AppState;

/// Files at a time in one batch.
const MAX_BATCH: usize = 50;

/// What re-encoding needs to remember between commands.
#[derive(Default)]
pub struct Convert {
    /// Detected once (a few test encodes), on first use.
    encoders: OnceCell<Encoders>,
    /// Files the user chose in the file dialog.
    picked: Mutex<HashSet<String>>,
}

#[tauri::command]
pub fn presets() -> Vec<Preset> {
    PRESETS.to_vec()
}

/// The video encoders that work here (hardware ones passed a test encode) and the audio encoders.
#[tauri::command]
pub async fn encoders(convert: State<'_, Convert>) -> Result<Encoders> {
    Ok(convert.encoders.get_or_init(detect).await.clone())
}

/// Why `encode` cannot be done (a stable code the window words), or nothing when it can.
#[tauri::command]
pub fn check_encode(encode: Encode) -> Option<&'static str> {
    check(&encode).err()
}

/// The file dialog, for files to re-encode; the paths the user chose (none when the dialog was closed).
#[tauri::command]
pub async fn pick_files(app: AppHandle, convert: State<'_, Convert>) -> Result<Vec<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(
            "Video",
            &[
                "mp4", "m4v", "mkv", "webm", "mov", "ts", "m2ts", "avi", "flv", "wmv", "mpg",
                "mpeg", "3gp", "ogv",
            ],
        )
        .pick_files(move |picked| {
            let _ = tx.send(picked.unwrap_or_default());
        });
    let paths: Vec<String> = rx
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let Ok(mut known) = convert.picked.lock() {
        known.extend(paths.iter().cloned());
    }
    Ok(paths)
}

/// Queue a re-encode of each file; `label` names the new files (`clip [label].mkv`), the encode's short name when
/// unset. Every file is checked before any is queued.
#[tauri::command]
pub fn reencode(
    state: State<'_, AppState>,
    convert: State<'_, Convert>,
    inputs: Vec<String>,
    encode: Encode,
    label: Option<String>,
) -> Result<Vec<String>> {
    if inputs.is_empty() || inputs.len() > MAX_BATCH {
        return Err(EngineError::invalid("Choose between 1 and 50 files"));
    }
    let history = state.manager.store().history()?;
    let known = |path: &str| {
        convert.picked.lock().is_ok_and(|p| p.contains(path))
            || state
                .finished
                .lock()
                .is_ok_and(|f| f.iter().any(|x| x == path))
            || history.iter().any(|h| h.path.as_deref() == Some(path))
    };
    let label = label
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .unwrap_or_else(|| self::label(&encode));
    let jobs: Vec<Reencode> = inputs
        .into_iter()
        .map(|input| Reencode {
            input,
            encode,
            label: label.clone(),
        })
        .collect();
    for j in &jobs {
        if !known(&j.input) {
            return Err(EngineError::invalid("The file to re-encode is not there"));
        }
        validate(j)?;
    }
    jobs.iter().map(|j| state.manager.add_reencode(j)).collect()
}
