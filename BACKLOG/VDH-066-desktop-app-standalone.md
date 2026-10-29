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

- [ ] Paste URL -> kind, qualities, live and AES-128 shown; protected streams refused -> download
- [ ] Queue (pause/resume/retry/cancel/stop/remove), history (until cleared, can be turned off, open / show in folder),
      settings saved in the queue database and applied while jobs run
- [ ] Tray with close-to-tray, start at login (opt-in), OS notifications, single instance, English and Italian
- [ ] Linux E2E of the real app with tauri-driver (`npm run test:desktop`)
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
