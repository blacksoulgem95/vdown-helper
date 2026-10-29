---
id: VDH-078
title: CI: the app E2E's live probe sometimes never answers
status: done
priority: P2
area: test
depends_on: [VDH-067]
---

# VDH-078: CI: the app E2E's live probe sometimes never answers

## Description

In the `app-e2e` CI job, the step "a live recording runs until Stop" sometimes times out waiting for the window to show
what the address is (`[data-testid="probed"]`) after pressing Check on a live HLS address; the steps before it (an HLS
download, a DRM refusal) pass. Seen on PR #19 heads `98dc4b0` and `3067fc1` (one run each); the same step passed in the
other CI runs of PR #19 (`f69bea1` and `a6d2cfe` twice each), in PR #18's runs, and in every local run (14 runs, before and after the
settings fix). The live fixture answers at once (`e2e/server.mjs` `liveResponse`), so the wait is in the
app or its window.

## Acceptance criteria

- [x] The cause found from a failing run (the step now reports what the window shows: the address field, any message,
      whether Check is busy) and fixed in the app or the test
- [x] The step passes in repeated CI runs

## Notes

- Diagnostics added in PR #19 (`e2e/desktop.mjs`, the live step's `catch`).
- Not a flake to rerun: if the probe can hang, a user's Check can too.
- Cause (PR #20, head `e083aa6`): the address field held the previous step's address followed by the live one
  (`…/hls-drm/index.m3u8http://…/__live/hls/index.m3u8…`), so the probe asked for a URL that does not exist (HTTP
  404) and the window never showed a description. WebKitWebDriver's element clear empties the field without the
  `input` event React listens to, so React kept the old text; the test's `type` now empties the field the way a
  user's edit does (the native value setter and an `input` event) and checks the field holds exactly what was typed.
  The app was not at fault: a user's own edit sends those events.
- Done: the step passed in both `app-e2e` runs on `1110509` (CI runs 40831516844 and 40831511667 (Desktop), 40831516905 and 40831511843 (check, e2e) on `1110509`) and in every local run since the fix.
