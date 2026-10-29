---
id: VDH-073
title: E2E: closing the tab while recording waits for relayed chunks, not a fixed sleep
status: done
priority: P2
area: test
depends_on: []
---

# VDH-073: E2E waits for relayed recording chunks

## Description

The step "stream: closing the tab while recording keeps what was recorded" recorded for a fixed 3 s of wall-clock time,
then closed the tab and asked for more than 1.5 s of video. The page relays a recording in 1 s chunks, so on a loaded
runner fewer chunks reached the extension before the close: CI run 40792332434 on PR #13 got 1.48 s (the other run on
the same commit, and the re-run, passed).

## Acceptance criteria

- [x] The step closes the tab only after the job's byte count rose three times (three chunks relayed)
- [x] Full E2E green locally and in CI

## Notes

`relayedChunks(jobId, n)` in `e2e/run.mjs` polls the job's `progress.bytesDone`; every relayed chunk raises it, and
counts written together only make it wait longer.
- Verified on `60bbb4b` (PR #14): E2E 113/113 locally, CI `e2e` runs 40795079552 and 40795917797 green.
