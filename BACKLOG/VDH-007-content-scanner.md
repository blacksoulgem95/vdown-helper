---
id: VDH-007
title: Content-script DOM and performance scanner
status: todo
priority: P0
area: content
depends_on: [VDH-003, VDH-006]
---

# VDH-007: Content-script DOM and performance scanner

## Description

Injected on demand via `chrome.scripting`. Collects `video`/`audio`, `currentSrc`, `src`, `<source>`, relevant anchors, `performance.getEntriesByType('resource')` media/manifest entries, and video element metadata (duration, videoWidth/Height). Reports `blob:` sources as inspect-only. Reads only; never mutates the page.

## Acceptance criteria

- [ ] Idempotent re-injection
- [ ] Handles shadow DOM open roots and same-origin iframes where accessible
- [ ] No page data beyond media URLs/metadata leaves the scanner
- [ ] Unit tests with jsdom fixtures

## Notes

_None yet._
