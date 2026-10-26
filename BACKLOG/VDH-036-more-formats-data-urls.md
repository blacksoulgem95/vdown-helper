---
id: VDH-036
title: More container/audio formats and data: URLs
status: todo
priority: P1
area: lib
depends_on: [VDH-033]
---

# VDH-036: More container/audio formats and data: URLs

## Description

Add FLV, AVI, WMV, 3GP, MPG, ASF, AIFF, WMA, Opus and friends to detection, naming and container-compatibility rules (copy only, never re-encode video). Decode data: media sources inside the page and hand them to the pipeline.

## Acceptance criteria

- [ ] New formats detected by URL and MIME with correct extensions
- [ ] Remux rules refuse combinations that would need video re-encoding
- [ ] data: media is saved correctly and size-capped; data: is never fetched by the extension
- [ ] Unit tests and an E2E data: download

## Notes

_None yet._
