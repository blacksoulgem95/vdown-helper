//! vdown-helper's desktop app: a window over `vdh-engine`'s persistent queue. Paste a media or playlist address, pick a
//! quality, and the download runs outside the browser, keeps running in the tray when the window is closed, and
//! continues after a restart. Design: `docs/desktop.md`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod i18n;
mod link;
mod settings;
mod tray;

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Emitter as _, Manager as _, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_notification::NotificationExt as _;
use tokio_util::sync::CancellationToken;
use vdh_engine::Event;
use vdh_engine::manager::{EventSink, Manager};
use vdh_engine::store::Store;

use commands::{AppState, show};
use settings::AppSettings;

/// Given when the app starts at login, or when the browser's relay starts it: it stays in the tray.
pub const HIDDEN: &str = "--hidden";

/// Hold the running jobs (they continue at the next start) and leave.
pub fn quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        if state.quit.is_cancelled() {
            return;
        }
        state.quit.cancel();
        let queue = state.queue.lock().ok().and_then(|mut q| q.take());
        if let Some(q) = queue {
            let _ = q.await;
        }
        app.exit(0);
    });
}

/// A job ended: remember its file and tell the user, when they want to be told.
fn finished(app: &AppHandle, id: &str, stage: &str, path: Option<&str>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let (Some(p), Ok(mut f)) = (path, state.finished.lock()) {
        f.push(p.to_string());
    }
    let s = state.settings();
    if !s.notifications {
        return;
    }
    let (title, name) = match stage {
        "completed" => (
            "notifyCompleted",
            path.and_then(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned()),
        ),
        "failed" => (
            "notifyFailed",
            state
                .manager
                .store()
                .get(id)
                .ok()
                .flatten()
                .and_then(|j| j.job["request"]["filename"].as_str().map(String::from)),
        ),
        _ => return,
    };
    let lang = i18n::resolve(&s.language);
    let _ = app
        .notification()
        .builder()
        .title(i18n::t(lang, title, &[]))
        .body(name.unwrap_or_default())
        .show();
}

fn sink(app: &AppHandle, link: Arc<OnceLock<Arc<link::server::Link>>>) -> EventSink {
    let app = app.clone();
    Arc::new(move |id: &str, e: &Event| {
        if let Some(l) = link.get() {
            l.event(id, e);
        }
        match e {
            // the window reads progress itself, a few times a second
            Event::Progress(_) | Event::NeedsCookies { .. } => return,
            Event::Stage { .. } => {}
            Event::Finished { stage, path, .. } => finished(&app, id, stage, path.as_deref()),
        }
        let _ = app.emit("queue-changed", id);
    })
}

fn setup(
    app: &AppHandle,
    browsers: Vec<link::host::Registered>,
) -> Result<(), Box<dyn std::error::Error>> {
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let store = Arc::new(Store::open(&data.join("queue.db"))?);
    let settings = AppSettings::load(&store);
    let default_out = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())?
        .join("vdown-helper");
    let staging = data.join("staging");
    let link_cell = Arc::new(OnceLock::new());
    let manager = Arc::new(Manager::new(
        store,
        settings.options(&default_out, staging.clone()),
        sink(app, link_cell.clone()),
    ));
    // the browser link (registered with the browsers in `main`), served on the local socket
    let server = link::server::Link::new(manager.clone());
    let _ = link_cell.set(server.clone());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.serve().await {
            eprintln!("vdown-helper: the browser link stopped: {e}");
        }
    });
    let quit = CancellationToken::new();
    let queue = {
        let (m, q) = (manager.clone(), quit.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(e) = m.run(false, None, q).await {
                eprintln!("vdown-helper: the queue stopped: {e}");
            }
        })
    };
    app.manage(AppState {
        manager,
        settings: Mutex::new(settings),
        default_out,
        staging,
        quit,
        queue: Mutex::new(Some(queue)),
        finished: Mutex::new(Vec::new()),
        data,
        browsers: Mutex::new(browsers),
    });
    tray::create(app)?;
    if !std::env::args().any(|a| a == HIDDEN) {
        show(app);
    }
    Ok(())
}

/// Only `quit` ends the app (it holds the running jobs first). On macOS the Dock icon brings the window back.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn on_run(app: &AppHandle, e: RunEvent) {
    match e {
        RunEvent::ExitRequested {
            api, code: None, ..
        } => api.prevent_exit(),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // started by the browser: only pass messages to the running app (starting it if needed)
    if link::relay::launched_by_browser(&args) {
        std::process::exit(link::relay::run());
    }
    // the browser link first: written for every browser found, before (and whatever happens to) the window
    let browsers = link::host::program()
        .zip(link::data_dir())
        .map(|(p, d)| link::host::register(&p, &d))
        .unwrap_or_default();
    tauri::Builder::default()
        // first, so a second launch only brings the running app forward (one started for the browser stays hidden)
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == HIDDEN) {
                show(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![HIDDEN]),
        ))
        .invoke_handler(tauri::generate_handler![
            commands::probe,
            commands::add,
            commands::jobs,
            commands::control,
            commands::history,
            commands::clear_history,
            commands::get_settings,
            commands::save_settings,
            commands::pick_folder,
            commands::open_file,
            commands::browser_link,
            commands::repair_browser_link,
        ])
        .setup(move |app| setup(app.handle(), browsers))
        .on_window_event(|window, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                api.prevent_close();
                let app = window.app_handle();
                if app.state::<AppState>().settings().close_to_tray {
                    let _ = window.hide();
                } else {
                    quit(app);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("the app starts")
        .run(on_run);
}
