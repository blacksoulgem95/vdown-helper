---
id: VDH-067
title: Native link: extension hands jobs to the desktop app
status: done
priority: P1
area: desktop
depends_on: [VDH-066]
---

# VDH-067: Native link: extension hands jobs to the desktop app

## Description

Chrome Native Messaging host `io.github.blacksoulgem95.vdownhelper`. Chrome launches a relay that talks to the running
app over local IPC, so jobs survive the browser closing.

## Acceptance criteria

- [x] Host manifest self-registered for Chrome, Chromium, Edge, Brave, Vivaldi, Opera; 'Repair browser link' in Settings
- [x] Extension: optional `nativeMessaging` + `cookies`; `desktop` pipeline; routing setting (never / streams and
      re-encodes (default) / always); 'Send to desktop app' on cards
- [x] Cookies of granted origins only, for one job, memory only; after an app restart the job waits for the browser
- [x] Extension <-> app E2E in real Chromium: hand-off, progress, cancel, cookie job, forged DRM request refused by the
      app
- [x] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md` (protocol v1 there, as built).
- Split: pushing MSE captures and recordings to the app for re-encoding moved to VDH-077 (it needs the re-encode
  options of VDH-068 to be useful).
- Done: PR #19 head `a6d2cfe` green in CI: `check` + `e2e` (runs 40824425000, 40824419969) and `Desktop` (runs
  40824425024, 40824420142: rust on ubuntu-22.04, windows-latest, macos-14, `engine-fixtures`, `app-e2e`, `link-e2e`).
  Locally on `84bed62` (`a6d2cfe` changes only the CI workflow): typecheck, lint, format:check, unit 698/698, build,
  check:dist, cargo fmt/clippy/test with fixtures, app E2E 8/8, link E2E 8/8, extension E2E 113/113; the full suite runs
  again on the done commit before the merge.
- Found on the way: a settings save answering after the user changed a switch undid the change (fixed, `84bed62`); the
  first launch on a fresh CI runner takes over 30 s, so the browser link is now written before the window starts
  (`3067fc1`); `ubuntu-latest` moved to 26.04, where WebKitWebDriver is `webkitgtk-webdriver` (`a6d2cfe`). An
  intermittent live-probe timeout seen twice in CI and never locally is tracked in VDH-078.
- After an app restart, a job that was given cookies waits for the browser: covered by unit tests on both sides (the
  engine's `a_job_given_cookies_waits_for_them_after_a_restart`, the extension's `needs-cookies` test), not by the
  browser E2E.

