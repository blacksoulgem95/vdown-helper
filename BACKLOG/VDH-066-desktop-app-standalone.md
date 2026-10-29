---
id: VDH-066
title: Desktop app (Tauri v2): window, queue, history, settings, tray
status: done
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
- [x] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- The window is `desktop/ui` (`npm run desktop:ui`); the app embeds it when compiled. ffmpeg comes from the PATH (or
  `VDH_FFMPEG`) until packaging bundles it (VDH-069). The workspace now needs Rust 1.90 (Tauri 2.12).
- The app E2E (`e2e/desktop.mjs`, 8 steps) runs the app in its own D-Bus session: an HLS download, the notification
  that it finished (seen by `dbus-monitor`), a DRM refusal, a live recording stopped from the queue, settings and history
  surviving a restart, start at login registered and removed, closing the window (a real `WM_DELETE_WINDOW`,
  `e2e/wm-close.py`) hiding it to the tray with the app still running, and a second launch bringing the window back and
  exiting. Not driven: the tray menu itself (Xvfb has no tray host) and how notifications look.
- Done: PR #18 head `5e79b0b` green in CI: `check` + `e2e` (runs 40815886968, 40815879938) and `Desktop` (runs
  40815886961, 40815880260: rust on ubuntu-22.04, windows-latest, macos-14, `engine-fixtures`, `app-e2e` 8/8). Locally:
  the app E2E 8/8 on `5e79b0b`; the rest of the suite (unit 679/679, build, check:dist, cargo with fixtures, extension
  E2E 113/113) on `9d5046a`, which differs only by the app E2E, its CI job and the notes; the full suite runs again on
  the done commit before the merge. The first CI run failed on Windows (tauri-build needs `icons/icon.ico`); `9d5046a`
  added it.
