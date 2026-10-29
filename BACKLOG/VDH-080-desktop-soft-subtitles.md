---
id: VDH-080
title: Desktop subtitles: download, convert and embed as soft subtitles
status: todo
priority: P3
area: desktop
depends_on: [VDH-068]
---

# VDH-080: Desktop subtitles: download, convert and embed as soft subtitles

## Description

Subtitle tracks the scan or the page lists (WebVTT, TTML, SRT, HLS/DASH subtitle renditions) downloaded by the app,
converted with `vdh-core`'s subtitle code, and embedded as soft (selectable) tracks in MKV or MP4 (mov_text), with
their language.

## Acceptance criteria

- [ ] Subtitle downloads and conversions in the app (the same results as the extension's)
- [ ] Embedded as soft tracks with language tags; checked with ffprobe in the app E2E
- [ ] CI green on the PR head

## Notes

- Split from VDH-068.
