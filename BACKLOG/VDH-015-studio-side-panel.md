---
id: VDH-015
title: Studio configure screen (side panel)
status: done
priority: P0
area: ui
depends_on: [VDH-012, VDH-014]
---

# VDH-015: Studio configure screen (side panel)

## Description

Side panel page for CONFIGURE: preview/thumbnail when available, source URL, playlist info, variants, audio track selection, output mode (Video+Audio, Audio Only, Video Only, Original), format/container, filename, destination behaviour, estimated output size when calculable, validation of incompatible combos, explicit Start button.

## Acceptance criteria

- [x] Only real variants/options displayed
- [x] Incompatible combos block Start with a reason
- [x] Never auto-starts a download
- [x] Screenshot reviewed in real Chromium

## Notes

Studio opened as a tab by automation (the real side panel is VDH-028). Options are derived from the planner; blocked combinations are disabled with reasons; Start is never automatic.
