---
id: VDH-018
title: Browser E2E in real Chromium
status: todo
priority: P0
area: test
depends_on: [VDH-014, VDH-015, VDH-016]
---

# VDH-018: Browser E2E in real Chromium

## Description

Playwright loads the unpacked build (`--load-extension`) against local fixture servers: MP4, HLS master + media playlists + TS segments, AES-128 HLS, cross-origin CORS failure, unsupported source. Asserts detection, variants, direct + HLS download, cancel/retry, and zero console, manifest or CSP errors in service worker, popup, options, side panel. Captures screenshots.

## Acceptance criteria

- [ ] All scenarios pass locally
- [ ] No console errors / CSP violations
- [ ] Screenshots saved and reviewed
- [ ] Separate CI job

## Notes

_None yet._
