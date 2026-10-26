---
id: VDH-017
title: Unit test suite
status: done
priority: P0
area: test
depends_on: [VDH-005, VDH-006, VDH-009]
---

# VDH-017: Unit test suite

## Description

Vitest coverage for: HLS master and media parsing, relative URL resolution, invalid manifests, duplicate detection, filename sanitisation, download state transitions, unsupported formats, failed downloads, A/V stream compatibility, settings persistence, i18n catalog parity.

## Acceptance criteria

- [x] All listed areas covered
- [x] Typed fake `chrome` API shared test helper
- [x] `npm test` green locally (CI workflow written; its first GitHub run is tracked in VDH-022)

## Notes

230+ tests in 16 files. Every area listed in the product brief has dedicated tests.
