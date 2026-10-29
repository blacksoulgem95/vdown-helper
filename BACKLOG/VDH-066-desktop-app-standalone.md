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
- Done: PR #18 head `9d5046a` green in CI: `check` + `e2e` (runs 40814597184, 40814591638) and `Desktop` (runs
  40814597143, 40814591643: rust on ubuntu-22.04, windows-latest, macos-14, `engine-fixtures`, `app-e2e`). Locally on
  the same head: typecheck, lint, format:check, unit 679/679, build, check:dist, `cargo fmt/clippy/test` with
  `VDH_REQUIRE_FIXTURES=1`, desktop app E2E 4/4 (`xvfb-run -a npm run test:desktop`), extension E2E 113/113. The first
  CI run failed on Windows (tauri-build needs `icons/icon.ico`); `9d5046a` added it.
