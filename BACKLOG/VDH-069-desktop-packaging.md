---
id: VDH-069
title: Desktop packaging, updater and release workflow
status: todo
priority: P1
area: build
depends_on: [VDH-066]
---

# VDH-069: Desktop packaging, updater and release workflow

## Description

Installers for Windows x64/arm64 (MSI + NSIS), macOS universal dmg and Linux x64 (AppImage, deb, rpm), unsigned until certificates
exist. Pinned GPL ffmpeg verified by SHA-256. Tauri updater: checks at start, installs after the user confirms; deb/rpm only notify.

## Acceptance criteria

- [ ] `desktop-release.yml`: `desktop-vX.Y.Z` tags, patch by default, `#desktop-minor` / `#desktop-major`
- [ ] Signed updater artifacts; `latest.json` on a rolling `desktop-latest` release
- [ ] Installer smoke tests on each OS (install, `--self-test`, host manifest present, uninstall)
- [ ] GPL text and ffmpeg source link in every installer and in About; site download section
- [ ] First `desktop-v1.0.0` released
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
