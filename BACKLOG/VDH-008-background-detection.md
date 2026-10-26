---
id: VDH-008
title: Background detection and per-tab store
status: done
priority: P0
area: background
depends_on: [VDH-005, VDH-007]
---

# VDH-008: Background detection and per-tab store

## Description

Service worker orchestrates scan on popup open / rescan / (optional) auto-scan, probes URLs (HEAD / range fetch, manifest fetch), assigns downloadability verdicts with reasons, stores per-tab results in `chrome.storage.session`, clears on navigation, and optionally observes `webRequest` when the user has granted the optional permission.

## Acceptance criteria

- [x] Verdicts: downloadable / protected / inaccessible / unsupported / unknown, each with a reason
- [x] CORS and network failures degrade gracefully with a retry path
- [x] `webRequest` observer only active when permission granted and setting enabled
- [x] State survives service-worker restarts
- [x] Unit tests (analysis with an injected fetcher) plus E2E in real Chromium

## Notes

Verified in real Chromium: detection, verdicts, per-origin fallback, opt-in observer (finds a request made by a Web Worker), auto-scan + badge, and a forced service-worker shutdown (state and queue survive; scans work afterwards). The observer/auto-scan permissions are pre-granted by the E2E test build because automation cannot answer Chrome's prompt; the prompt flow itself is in VDH-028.
