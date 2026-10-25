---
id: VDH-008
title: Background detection and per-tab store
status: todo
priority: P0
area: background
depends_on: [VDH-005, VDH-007]
---

# VDH-008: Background detection and per-tab store

## Description

Service worker orchestrates scan on popup open / rescan / (optional) auto-scan, probes URLs (HEAD / range fetch, manifest fetch), assigns downloadability verdicts with reasons, stores per-tab results in `chrome.storage.session`, clears on navigation, and optionally observes `webRequest` when the user has granted the optional permission.

## Acceptance criteria

- [ ] Verdicts: downloadable / protected / inaccessible / unsupported / unknown, each with a reason
- [ ] CORS and network failures degrade gracefully with a retry path
- [ ] `webRequest` observer only active when permission granted and setting enabled
- [ ] State survives service-worker restarts
- [ ] Unit tests with fake chrome API

## Notes

_None yet._
