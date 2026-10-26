---
id: VDH-007
title: Content-script DOM and performance scanner
status: done
priority: P0
area: content
depends_on: [VDH-003, VDH-006]
---

# VDH-007: Content-script DOM and performance scanner

## Description

Injected on demand via `chrome.scripting`. Collects `video`/`audio`, `currentSrc`, `src`, `<source>`, relevant anchors, `performance.getEntriesByType('resource')` media/manifest entries, and video element metadata (duration, videoWidth/Height). Reports `blob:` sources as inspect-only. Reads only; never mutates the page.

## Acceptance criteria

- [x] Idempotent re-injection
- [x] Handles shadow DOM open roots and same-origin iframes where accessible
- [x] No page data beyond media URLs/metadata leaves the scanner
- [x] Unit tests with jsdom fixtures

## Notes

jsdom tests in `tests/scanner.test.ts`; exercised repeatedly in real Chromium by the E2E suite (rescans, iframes not present in fixtures; same-origin iframes are covered by the jsdom test only).
