---
id: VDH-014
title: Popup UI
status: done
priority: P0
area: ui
depends_on: [VDH-008, VDH-009, VDH-013]
---

# VDH-014: Popup UI

## Description

About 420px popup: header (logo, SCANNING/READY indicator, settings, version), current-page panel with RESCAN PAGE, grouped media cards (badges, size or SIZE UNKNOWN, expandable technical details, DOWNLOAD, CONFIGURE), download queue with controls and stage chips, empty state with CSS visual and SCAN AGAIN.

## Acceptance criteria

- [x] Every control works
- [x] Loading, success, failure states
- [x] Keyboard navigable
- [x] Screenshot reviewed in real Chromium

## Notes

E2E exercises: scan state, cards/details, DOWNLOAD, CONFIGURE (selection hand-off; `sidePanel.open()` itself needs a real toolbar click, see VDH-028), RESCAN, Settings gear, Copy URL, pause/resume/cancel/retry/remove/clear, Open/Show clicks, empty and restricted-page states, keyboard focus order and rings.
