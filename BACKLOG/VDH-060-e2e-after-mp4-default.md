---
id: VDH-060
title: E2E follows the MP4 default and waits for the navigation clear
status: done
priority: P0
area: test
depends_on: [VDH-058, VDH-059]
---

# VDH-060: E2E follows the MP4 default and waits for the navigation clear

## Description

PR #9 (VDH-058, VDH-059) reached `main` with `e2e` at 111/113 (CI runs 40432896104, 40433263802, 40433324990 on
`af66630`). Both failures are in the tests, not the product:

1. "HLS master (muxed audio): segments are joined on disk into a valid TS" clicked DOWNLOAD and expected `.ts`. One click
   now saves streams as MP4 (VDH-059), which the funnel step already covers. The byte-for-byte join still exists: it is
   what *Default video container → keep the original* does, and the fallback for streams too large to convert.
2. "a stream link pasted by hand … forgotten on navigation" read storage right after `page.goto`. Since VDH-058 the clear
   runs after `tabs.onUpdated` has compared the old and new address, so an immediate read races it (CI lost, local won).

## Acceptance criteria

- [x] The HLS master step sets `defaultContainer: 'original'` first and still checks the TS join (no FFmpeg, 3/3
      segments, clean decode), then restores the defaults
- [x] The pasted-link step waits (bounded) for the clear instead of reading once
- [x] Full local suite green on the PR head, E2E 113/113
- [x] CI `check` and `e2e` green on the PR head

## Notes

- Verified: local suite (E2E 113/113) on a9d64c1; CI on PR #10 green: CI runs 40622400239 and 40622404968 (check, e2e), Desktop runs 40622400375 and 40622405037 (rust on Linux, Windows, macOS).
