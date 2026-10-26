---
id: VDH-048
title: CI green on GitHub, release bump rule, PR-and-merge flow
status: in-progress
priority: P0
area: build
depends_on: [VDH-022, VDH-032, VDH-047]
---

# VDH-048: CI green on GitHub, release bump rule, PR-and-merge flow

## Description

The e2e job on GitHub failed on the branch head (two steps that pass locally). Fix the causes, make every completed stage go to `main` through a
new PR that is merged once CI is green, and stop prose that mentions `#minor` / `#major` from bumping the release version (that is how `v1.0.0`
was published by accident).

## Acceptance criteria

- [x] Finished segment downloads always report their final counters (`n / n`), however the segments finish (the CI failure in runs 16, 20, 24; reproduced in `tests/progress-report.test.ts` before the fix)
- [x] The Studio E2E step waits for the scan it depends on and explains itself if it fails
- [x] `#minor` / `#major` bump the version only on a line of their own; `[minor]` / `[major]` only in a commit subject; tested (`tests/version.test.ts`, incl. the message that caused the accidental 1.0.0)
- [x] `CLAUDE.md` working agreement: open a PR per completed stage and merge it once CI is green
- [ ] CI (`check` and `e2e`) green on GitHub on the PR head, PR merged, release published with the expected version

## Notes

- Segment counters: `writeSegments` reported after every flush, including one that wrote nothing because a later segment finished first
  (`0 / 3`); the job's progress sender throttles to one event per 250 ms, so on a fast runner that stale report could be the last one with counters.
  Now a flush that wrote nothing reports nothing, and a report that completes a stage is never throttled.
- Studio step: opening a popup rescans the tab; `select()` now waits until that scan is `ready` and lists the resource, and prints what the Studio
  shows if the heading still does not appear.
- Local: 608 unit tests, full E2E 108/108. CI on GitHub: see the PR.
