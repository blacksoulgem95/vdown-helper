//! The tray icon: the app keeps running there (and its jobs with it) when the window is closed.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager as _, Wry};

use crate::commands::{AppState, show};
use crate::i18n::t;

const ID: &str = "main";

fn menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let lang = app.state::<AppState>().language();
    let open = MenuItem::with_id(app, "show", t(lang, "trayShow", &[]), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t(lang, "trayQuit", &[]), true, None::<&str>)?;
    Menu::with_items(app, &[&open, &quit])
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("vdown-helper")
        .menu(&menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => show(app),
            "quit" => crate::quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Rebuild the menu in the language just chosen.
pub fn refresh(app: &AppHandle) {
    if let (Some(tray), Ok(m)) = (app.tray_by_id(ID), menu(app)) {
        let _ = tray.set_menu(Some(m));
    }
}
