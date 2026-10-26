---
id: VDH-050
title: Popup funnel - from opening the popup to the right download in one click
status: done
priority: P1
area: ui
depends_on: [VDH-049]
---

# VDH-050: Popup funnel - from opening the popup to the right download in one click

## Description

A conversion-first teardown of the popup (the extension has no account, trial or telemetry, so "conversion" is opening the
popup and starting the right download). Keep the cyan/magenta brand, remove what slows the first download down.

## Acceptance criteria

- [x] Media tabs are ranked (savable with one click, then video, quality, length, the page itself, detection order); the top one is
      marked BEST MATCH and its DOWNLOAD is above the fold of the 600 px popup (unit + E2E)
- [x] Cards lead with what tells them apart ("1080p · HLS · 3 qualities"); one chip at most for status, none for "downloadable";
      unknown size/codec are not printed (unit + E2E)
- [x] Header and page row take one line each: no tagline, version chip or footer slogan; the status pill is quiet while ready
- [x] The empty state names the cause and offers exactly one fix (allow embedded players, reload, or rescan) (unit + E2E)
- [x] The queue shows running jobs and the last 3 finished, then "Show N more"; finished jobs drop the stage track; Open and Retry
      are labelled buttons; Chrome's interrupt codes come with a sentence (unit + E2E)
- [x] en/it strings in sync; unused keys removed
- [x] CI green on the PR head

## Notes

- Verified: unit tests (`tests/funnel.test.ts`), local E2E 111/111 on `a586278`, CI run 40328166372 on the PR head and 40328676601 on `main`; merged as `a41adfd`, released as `v1.1.2`.

- Not measurable here (no telemetry by design): real-world click-through. A look at real sites in branded Chrome -> VDH-028.
