---
id: VDH-016
title: Options page and settings persistence
status: todo
priority: P1
area: ui
depends_on: [VDH-003, VDH-013]
---

# VDH-016: Options page and settings persistence

## Description

Settings: default mode, preferred quality, default audio format, naming template, subfolder, auto-scan (requests optional permissions with explanation), max concurrent downloads, encoding limits (incl. memory cap), notifications, clear history, reset. Persisted in `chrome.storage.local` with schema versioning and validation.

## Acceptance criteria

- [ ] Settings round-trip tests
- [ ] Corrupt stored settings fall back to defaults
- [ ] Optional permission grant/revoke reflected in UI
- [ ] Permission explanations present

## Notes

_None yet._
