//! What the window can ask of the app. The window names an address and the user's choices; the app probes the address
//! itself and builds the request (`vdh-core`), so a protected or malformed stream is refused here whatever the window
//! sends. Files are opened only when the history recorded them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager as _, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tokio_util::sync::CancellationToken;
use vdh_core::settings::Settings;
use vdh_engine::manager::Manager;
use vdh_engine::net::{Net, RequestHeaders};
use vdh_engine::probe::{Probed, Wanted, probe as probe_url};
use vdh_engine::store::{HistoryEntry, StoredHeaders};
use vdh_engine::{EngineError, ErrorCode, Result};

use crate::i18n;
use crate::settings::AppSettings;

pub struct AppState {
    pub manager: Arc<Manager>,
    pub settings: Mutex<AppSettings>,
    /// `Downloads/vdown-helper`, when the user picked no folder.
    pub default_out: PathBuf,
    pub staging: PathBuf,
    /// Ends the queue (jobs still running are held and continue at the next start).
    pub quit: CancellationToken,
    pub queue: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Files finished since the app started (they can be opened even with the history turned off).
    pub finished: Mutex<Vec<String>>,
}

impl AppState {
    pub fn settings(&self) -> AppSettings {
        self.settings
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    pub fn language(&self) -> &'static str {
        i18n::resolve(&self.settings().language)
    }
}

/// The user's choices for one address; unset ones follow the defaults.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Choice {
    pub mode: Option<String>,
    pub container: Option<String>,
    pub audio_format: Option<String>,
    pub audio_bitrate: Option<f64>,
    pub variant: Option<i64>,
}

impl From<Choice> for Wanted {
    fn from(c: Choice) -> Self {
        Self {
            mode: c.mode,
            container: c.container,
            audio_format: c.audio_format,
            audio_bitrate: c.audio_bitrate,
            variant: c.variant,
            filename: None,
        }
    }
}

async fn described(url: &str, choice: Choice) -> Result<Probed> {
    let net = Net::new(RequestHeaders::default())?;
    probe_url(&net, url.trim(), &Settings::default(), &choice.into()).await
}

/// What `url` is: its kind, qualities and the request the choices make of it. Protected streams are refused.
#[tauri::command]
pub async fn probe(url: String, choice: Option<Choice>) -> Result<Probed> {
    described(&url, choice.unwrap_or_default()).await
}

/// Queue `url` with the user's choices (probed again here: the window's description is not trusted).
#[tauri::command]
pub async fn add(
    state: State<'_, AppState>,
    url: String,
    choice: Option<Choice>,
) -> Result<String> {
    let probed = described(&url, choice.unwrap_or_default()).await?;
    state.manager.add(&probed.request, StoredHeaders::default())
}

/// The queue: every job that has not finished (finished ones are in the history).
#[tauri::command]
pub fn jobs(state: State<'_, AppState>) -> Result<Vec<Value>> {
    Ok(state
        .manager
        .store()
        .jobs()?
        .into_iter()
        .map(|j| j.job)
        .collect())
}

/// Pause, resume, retry, cancel, stop (a live recording) or remove a job. The running queue applies it.
#[tauri::command]
pub fn control(state: State<'_, AppState>, id: String, action: String) -> Result<()> {
    if !matches!(
        action.as_str(),
        "pause" | "resume" | "retry" | "cancel" | "stop" | "remove"
    ) {
        return Err(EngineError::invalid("Unknown action"));
    }
    if state.manager.store().request(&id, &action)? {
        Ok(())
    } else {
        Err(EngineError::invalid("No such job"))
    }
}

#[tauri::command]
pub fn history(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>> {
    state.manager.store().history()
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> Result<()> {
    state.manager.store().clear_history()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: AppSettings,
    /// The folder used when `outDir` is empty.
    pub default_out_dir: String,
    /// The language the window should use (`auto` resolved).
    pub language: &'static str,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> SettingsView {
    let settings = state.settings();
    SettingsView {
        language: i18n::resolve(&settings.language),
        default_out_dir: state.default_out.to_string_lossy().into_owned(),
        settings,
    }
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<SettingsView> {
    let s = settings.sanitized()?;
    let before = state.settings();
    if s.start_at_login != before.start_at_login {
        let auto = app.autolaunch();
        let changed = if s.start_at_login {
            auto.enable()
        } else {
            auto.disable()
        };
        changed
            .map_err(|e| EngineError::new(ErrorCode::Unknown, format!("Start at login: {e}")))?;
    }
    s.save(state.manager.store())?;
    state
        .manager
        .set_options(s.options(&state.default_out, state.staging.clone()));
    if let Ok(mut current) = state.settings.lock() {
        *current = s.clone();
    }
    if s.language != before.language {
        crate::tray::refresh(&app);
    }
    Ok(get_settings(state))
}

/// The folder picker; `None` when the user closed it.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked.and_then(|p| p.into_path().ok()));
    });
    rx.await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Open a finished file, or show it in its folder. Only files the queue finished can be opened.
#[tauri::command]
pub fn open_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    reveal: bool,
) -> Result<()> {
    let known = state.finished.lock().is_ok_and(|f| f.contains(&path))
        || state
            .manager
            .store()
            .history()?
            .iter()
            .any(|h| h.path.as_deref() == Some(path.as_str()));
    if !known || !Path::new(&path).exists() {
        return Err(EngineError::invalid("The file is no longer there"));
    }
    let opener = app.opener();
    let done = if reveal {
        opener.reveal_item_in_dir(&path)
    } else {
        opener.open_path(&path, None::<&str>)
    };
    done.map_err(|e| EngineError::new(ErrorCode::Unknown, e.to_string()))
}

/// Show the window (from the tray or a second launch).
pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}
