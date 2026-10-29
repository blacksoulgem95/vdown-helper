---
id: VDH-067
title: Native link: extension hands jobs to the desktop app
status: in-progress
priority: P1
area: desktop
depends_on: [VDH-066]
---

# VDH-067: Native link: extension hands jobs to the desktop app

## Description

Chrome Native Messaging host `io.github.blacksoulgem95.vdownhelper`. Chrome launches a relay that talks to the running
app over local IPC, so jobs survive the browser closing.

## Acceptance criteria

- [ ] Host manifest self-registered for Chrome, Chromium, Edge, Brave, Vivaldi, Opera; 'Repair browser link' in Settings
- [ ] Extension: optional `nativeMessaging` + `cookies`; `desktop` pipeline; routing setting (never / streams and
      re-encodes (default) / always); 'Send to desktop app' on cards
- [ ] Cookies of granted origins only, for one job, memory only; after an app restart the job waits for the browser
- [ ] Extension <-> app E2E in real Chromium: hand-off, progress, cancel, cookie job, forged DRM request refused by the
      app
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md` (protocol v1 there, as built).
- Split: pushing MSE captures and recordings to the app for re-encoding moved to VDH-077 (it needs the re-encode
  options of VDH-068 to be useful).
