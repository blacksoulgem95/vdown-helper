---
id: VDH-035
title: Subtitles and captions
status: todo
priority: P1
area: lib
depends_on: [VDH-034]
---

# VDH-035: Subtitles and captions

## Description

Detect WebVTT/SRT/TTML tracks from <track>, HLS subtitle renditions (segmented VTT stitched into one file) and DASH text sets; save as found; offer SRT conversion.

## Acceptance criteria

- [ ] Subtitle resources appear in their own tab
- [ ] Segmented HLS VTT is stitched with correct timestamps (X-TIMESTAMP-MAP)
- [ ] WebVTT and TTML convert to valid SRT (unit tests)
- [ ] Saved files are verified (E2E)

## Notes

_None yet._
