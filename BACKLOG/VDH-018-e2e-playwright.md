---
id: VDH-018
title: Browser E2E in real Chromium
status: done
priority: P0
area: test
depends_on: [VDH-014, VDH-015, VDH-016]
---

# VDH-018: Browser E2E in real Chromium

## Description

Playwright loads the unpacked build (`--load-extension`) against local fixture servers: MP4, HLS master + media playlists + TS segments, AES-128 HLS, cross-origin CORS failure, unsupported source. Asserts detection, variants, direct + HLS download, cancel/retry, and zero console, manifest or CSP errors in service worker, popup, options, side panel. Captures screenshots.

## Acceptance criteria

- [x] All scenarios pass locally
- [x] No console errors / CSP violations
- [x] Screenshots saved and reviewed
- [x] Separate CI job defined in `.github/workflows/ci.yml` (first GitHub run tracked in VDH-022)

## Notes

`npm run test:e2e` builds, validates and drives the real build against local fixtures. 41 steps, passing on consecutive runs. Not covered: Chrome's permission prompts, real toolbar popup/activeTab, `sidePanel.open()`, branded Chrome, Windows/macOS (VDH-028).
