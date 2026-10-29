---
id: VDH-066
title: Desktop app (Tauri v2): window, queue, history, settings, tray
status: in-progress
priority: P1
area: desktop
depends_on: [VDH-065, VDH-075]
---

# VDH-066: Desktop app (Tauri v2): window, queue, history, settings, tray

## Description

The app around `vdh-engine`: a window where the user pastes a media or playlist address, sees what it is (kind,
qualities, live, openly delivered encryption; protected streams refused) and queues it; the persistent queue with pause,
resume, retry, cancel, stop (live) and remove; the history with open / show in folder; settings (folder, jobs and
segments at a time, bandwidth cap, schedule window, history, notifications, close to tray, start at login, language). A
tray icon keeps the app and its jobs running when the window is closed; a second launch brings the running app forward.
The window reuses the extension's React components, theme, fonts, catalogs and Rust core; English and Italian.

Page scan, local files, clipboard watch and folder rules moved to VDH-076, so this stays one reviewable PR.

## Acceptance criteria

- [x] Paste URL -> kind, qualities, live and AES-128 shown; protected streams refused -> download
- [x] Queue (pause/resume/retry/cancel/stop/remove), history (until cleared, can be turned off, open / show in folder),
      settings saved in the queue database and applied while jobs run
- [x] Tray with close-to-tray, start at login (opt-in), OS notifications, single instance, English and Italian
- [x] Linux E2E of the real app with tauri-driver (`npm run test:desktop`)
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- The window is `desktop/ui` (`npm run desktop:ui`); the app embeds it when compiled. ffmpeg comes from the PATH (or
  `VDH_FFMPEG`) until packaging bundles it (VDH-069). The workspace now needs Rust 1.90 (Tauri 2.12).
- The app E2E (`e2e/desktop.mjs`, 8 steps) runs the app in its own D-Bus session: an HLS download, the notification
  that it finished (seen by `dbus-monitor`), a DRM refusal, a live recording stopped from the queue, settings and history
  surviving a restart, start at login registered and removed, closing the window (a real `WM_DELETE_WINDOW`,
  `e2e/wm-close.py`) hiding it to the tray with the app still running, and a second launch bringing the window back and
  exiting. Not driven: the tray menu itself (Xvfb has no tray host) and how notifications look.
- PR #18 head `9d5046a` was green in CI (runs 40814597184, 40814591638, 40814597143, 40814591643) and locally (unit
  679/679, cargo with fixtures, app E2E 4/4, extension E2E 113/113); the tray, start at login, notification and
  single-instance checks were added after it, so CI is awaited again on the new head. The first CI run failed on Windows
  (tauri-build needs `icons/icon.ico`); `9d5046a` added it.
