---
id: VDH-056
title: No false "frames could not be inspected" note; colons in titles become " - " in file names
status: done
priority: P2
area: ui
depends_on: [VDH-033]
---

# VDH-056: No false "frames could not be inspected" note; colons in titles become " - " in file names

## Description

Both found while making the store screenshots.

1. A page whose embedded player was scanned (its site allowed) still showed "1 embedded frame(s) from other sites could not be
   inspected": every parent counts its cross-origin children as unreadable, and the frames that then reported on their own were
   never subtracted.
2. A title such as "Live: the show" was saved as "Live_ the show" (a colon is not allowed on Windows). It is now "Live - the show";
   a colon that is not followed by a space still becomes "_".

## Acceptance criteria

- [x] The note counts only frames nobody could read (unit: one embed scanned and one ad frame not; A -> C -> D all scanned)
- [x] "Live: the show" -> "Live - the show"; other illegal characters unchanged (unit)
- [x] CI green on the PR head

## Notes

- PR #8 merged as `2507446` after CI (`check`, `e2e`) green on `8c8d283` (runs 40340268758, 40340258255) and the full local suite (E2E 112/112); `main` CI run 40430131398 green; Release run 40430131437 published `v1.2.0`.
