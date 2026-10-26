---
id: VDH-026
title: Popup showed READY before its first scan
status: done
priority: P2
area: ui
depends_on: [VDH-014]
---

# VDH-026: Popup showed READY before its first scan

## Description

Found as an E2E flake: until the first scan was requested, the popup had no state and displayed READY. It now shows SCANNING from the moment it opens (and gives up after 1.5 s if there is no tab to scan).

## Acceptance criteria

- [x] Header shows SCANNING immediately on open
- [x] No permanent SCANNING when no tab is available
- [x] E2E waits on READY and then finds a finished scan

## Notes

Fixed in `src/hooks/useTabMedia.ts`.
