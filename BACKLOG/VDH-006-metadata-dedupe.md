---
id: VDH-006
title: Media metadata and dedupe utilities
status: todo
priority: P1
area: lib
depends_on: [VDH-003, VDH-004]
---

# VDH-006: Media metadata and dedupe utilities

## Description

MIME/extension to format mapping, codec string parsing, duration and size estimation (bandwidth x duration for HLS), title inference, dedupe by normalised URL (ignoring volatile query params only when safe) and metadata, grouping by source/title.

## Acceptance criteria

- [ ] Dedupe tested with trailing slashes, fragments, equivalent query ordering
- [ ] Estimated sizes are labelled as estimates
- [ ] Unit tests

## Notes

_None yet._
