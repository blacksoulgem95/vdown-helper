---
id: VDH-006
title: Media metadata and dedupe utilities
status: done
priority: P1
area: lib
depends_on: [VDH-003, VDH-004]
---

# VDH-006: Media metadata and dedupe utilities

## Description

MIME/extension to format mapping, codec string parsing, duration and size estimation (bandwidth x duration for HLS), title inference, dedupe by normalised URL (ignoring volatile query params only when safe) and metadata, grouping by source/title.

## Acceptance criteria

- [x] Dedupe tested with fragments, default ports and equivalent query ordering (trailing slash is intentionally NOT collapsed: paths are significant)
- [x] Estimated sizes are labelled as estimates in the UI (data model has `sizeIsEstimate`; verify in VDH-014)
- [x] Unit tests

## Notes

Utilities in `src/lib/media.ts`, `src/lib/resources.ts`, `src/lib/compat.ts` (output planner). Tests: `tests/media.test.ts`, `resources.test.ts`, `compat.test.ts`.
