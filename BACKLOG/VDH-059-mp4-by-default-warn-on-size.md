---
id: VDH-059
title: Streams saved as MP4 by default; size only warns, never blocks
status: done
priority: P1
area: lib
depends_on: [VDH-050]
---

# VDH-059: Streams saved as MP4 by default; size only warns, never blocks

## Description

Reported: a stream was kept as `.ts` instead of being converted to MP4 by default; and "just warn the user about size, do not block
it". The one-click download always used the original container. The memory cap refused conversions above it, and even capped the
download itself.

## Acceptance criteria

- [x] New setting _Default video container_: MP4 (default) or keep the original; a HLS/DASH stream defaults to it, a plain file and
      "Original quality" keep the original (unit)
- [x] MP4 is kept even when the stream is large (warning `large-for-memory`); it falls back to the original container only when MP4
      cannot hold the codecs, and a fragmented-MP4 stream is not re-packaged (unit)
- [x] One click on an HLS-TS stream saves a decodable H.264 MP4 (E2E, ffprobe + full decode)
- [x] A single stream larger than the memory cap is downloaded in full and saved as `.ts` with a note on the job, also when FFmpeg
      fails (E2E: 140 MB with a 128 MB cap); only joining separate video and audio is still refused above the cap
- [x] The popup and the Studio show the warning before starting; en/it strings; README updated
- [x] CI green on the PR head

## Notes

- A real cure for very large streams is a streaming TS -> MP4 re-packager writing to disk segment by segment (no memory limit); not
  done here.

- Verified: local suite (E2E 113/113) on a9d64c1; CI on PR #10 green: CI runs 40622400239 and 40622404968 (check, e2e), Desktop runs 40622400375 and 40622405037 (rust on Linux, Windows, macOS).
