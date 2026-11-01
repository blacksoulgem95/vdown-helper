---
id: VDH-069
title: Desktop installers in every release (NSIS, MSI, DMG, AppImage, deb, rpm) with a pinned GPL ffmpeg
status: in-progress
priority: P1
area: build
depends_on: [VDH-066]
---

# VDH-069: Desktop installers in every release (NSIS, MSI, DMG, AppImage, deb, rpm) with a pinned GPL ffmpeg

## Description

Agreed with the owner (2026-11-01): the desktop app's installers are attached to the **same** GitHub release as the
extension (`v1.x.y`, one version), in every format of the plan: Windows x64 and arm64 (NSIS setup and MSI), macOS
universal DMG (11+), Linux x64 (AppImage, deb, rpm). Unsigned until certificates exist. A pinned GPL ffmpeg/ffprobe is
bundled (`desktop/ffmpeg.lock.json`, SHA-256 checked), installed as `vdh-ffmpeg` / `vdh-ffprobe` next to the app (a
name no system package uses), with its licence and source references in the installers' `licenses` folder.

## Acceptance criteria

- [ ] `installers.yml` builds every installer, installs each on its runner and runs the app's `--self-test` (the
      bundled ffmpeg and ffprobe run; the macOS programs are universal; the rpm lists them); run on pull requests that
      change the app or its packaging, and called by `release.yml`
- [ ] `release.yml` attaches the installers (with a `.sha256` each) to the extension's release; changes to `desktop/`
      and `core/` now release
- [ ] The engine uses the bundled ffmpeg (`VDH_FFMPEG`, else `vdh-ffmpeg` next to the program, else the PATH)
- [ ] GPL text, build and source references in every installer (`licenses/`)
- [ ] First release with installers published
- [ ] CI green on the PR head

## Notes

- Auto-update (signed `latest.json`) is VDH-085: it needs the owner's signing key as a repository secret. The site's
  download section is VDH-086.
- ffmpeg: BtbN FFmpeg-Builds n8.0.1 (month-end build kept for two years) for Windows and Linux, shaka-project
  static-ffmpeg-binaries n8.0.3 for macOS (joined into a universal program with lipo).
