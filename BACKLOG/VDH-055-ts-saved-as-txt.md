---
id: VDH-055
title: Streams saved as .txt on Linux (untyped staged file)
status: in-progress
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

- [ ] Every blob handed to Chrome carries the MIME type of its content, never an empty one (unit)
- [ ] Reproduced with a minimal extension: empty type -> `.txt`, `video/mp2t` -> `.ts` (Chromium on Linux)
- [ ] `npm run store:assets` drives a real HLS download with Chrome naming the file and fails unless it ends in `.ts`
- [ ] CI green on the PR head

## Notes

- Real-world Windows/macOS behaviour is not reproduced here -> VDH-028.
