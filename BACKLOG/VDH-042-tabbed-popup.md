---
id: VDH-042
title: Tabbed popup with frame grouping
status: done
priority: P1
area: ui
depends_on: [VDH-037]
---

# VDH-042: Tabbed popup with frame grouping

## Description

Popup tabs by type (Video, Audio, Subtitles, Images, Files, Assets) with counts; items grouped by source frame; controls for Capture/Record/Stop; English and Italian strings.

## Acceptance criteria

- [x] Tabs, counts and frame grouping work and are keyboard accessible
- [x] Large lists stay responsive (caps, virtual rendering where needed)
- [x] All new strings exist in en and it

## Notes

- Tabs (`src/components/Tabs.tsx`, WAI-ARIA tabs pattern: arrow keys, Home/End, roving tabindex) appear only when more than one kind was found; empty tabs
  are not shown; the first non-empty tab is active until the user picks one. Pure logic in `lib/tabs.ts` (tab of a resource, split, filter, frame grouping).
- Items are grouped by the frame they were found in ("This page" first, then "Embedded: <host>") whenever more than one frame has items.
- Large lists: scans are capped per kind (VDH-037), the popup renders 40 rows at a time with "Show N more", and the stored tab state stays small
  (320 images: 152 KB, scan + render about 1 s in the E2E).
- The headline count and the toolbar badge count video, audio and subtitles only; images and files have their own tab counts.
- Capture (fast), Record (real time / MediaStream / live) and "Stop and save" (queue) exist and are verified in the E2E (VDH-038, VDH-039, VDH-040).
