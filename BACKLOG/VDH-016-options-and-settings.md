---
id: VDH-016
title: Options page and settings persistence
status: in-progress
priority: P1
area: ui
depends_on: [VDH-003, VDH-013]
---

# VDH-016: Options page and settings persistence

## Description

Settings: default mode, preferred quality, default audio format, naming template, subfolder, auto-scan (requests optional permissions with explanation), max concurrent downloads, encoding limits (incl. memory cap), notifications, clear history, reset. Persisted in `chrome.storage.local` with schema versioning and validation.

## Acceptance criteria

- [x] Settings round-trip tests
- [x] Corrupt stored settings fall back to defaults
- [ ] Optional permission grant/revoke reflected in UI
- [x] Permission explanations present

## Notes

Round-trip, clamping, corrupt data and queued writes are unit-tested; persistence across reloads is E2E-tested. **Open:** grant/revoke of the optional all-sites / webRequest permissions through Chrome's real prompt cannot be automated (E2E stands in with install-time grants). Tracked in VDH-028.
