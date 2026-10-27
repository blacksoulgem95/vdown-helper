---
id: VDH-055
title: Streams saved as .txt on Linux (untyped staged file)
status: done
priority: P0
area: offscreen
depends_on: [VDH-047]
---

# VDH-055: Streams saved as .txt on Linux (untyped staged file)

## Description

Found while making the store screenshots with Chrome naming downloads itself (the E2E harness lets Playwright name them, which
hid it): an HLS stream saved without conversion was written as `… [1080p].txt` instead of `.ts`. When nothing needs FFmpeg, the
job handed Chrome the staged file from disk, which has no MIME type; Chrome then sniffs the bytes, an MPEG-TS file looks like
nothing it knows, and with the extension download API on Linux (where `/etc/mime.types` maps `.ts` to a Qt translation format)
the name ends up `.txt`. The ZIP path handed over an untyped file the same way.

## Acceptance criteria

- [x] Every blob handed to Chrome carries the MIME type of its content, never an empty one (unit)
- [x] Reproduced with a minimal extension: empty type -> `.txt`, `video/mp2t` -> `.ts` (Chromium on Linux)
- [x] `npm run store:assets` drives a real HLS download with Chrome naming the file and fails unless it ends in `.ts`
- [x] CI green on the PR head

## Notes

- PR #8 merged as `2507446` after CI (`check`, `e2e`) green on `8c8d283` (runs 40340268758, 40340258255) and the full local suite (E2E 112/112); `main` CI run 40430131398 green; Release run 40430131437 published `v1.2.0`.

- Real-world Windows/macOS behaviour is not reproduced here -> VDH-028.
