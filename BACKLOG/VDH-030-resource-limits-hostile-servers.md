---
id: VDH-030
title: Byte, time and count limits against hostile servers and playlists
status: done
priority: P1
area: security
depends_on: [VDH-011]
---

# VDH-030: Byte, time and count limits against hostile servers and playlists

## Description

Review finding: segments were read unbounded with no stall timeout; huge or endless responses could crash the offscreen document; a stalled server held a concurrency slot forever; page-controlled strings and track lists could overflow chrome.storage.session.

## Acceptance criteria

- [x] Every segment/key/init read has a size cap (256 MB / 1 KB for keys) and a 30 s header and idle timeout
- [x] Total staged bytes are capped for every pipeline; playlists over 20,000 segments are refused
- [x] A timeout is reported as a network failure, a user cancel as cancelled
- [x] Audio tracks (50), titles and names (200 chars) are bounded; stored per-tab state is shrunk below 1 MB instead of failing the scan
- [x] E2E: a server that stalls mid-body fails the job after ~30 s

## Notes

Constants at the top of the limits block in `src/offscreen/hls.ts`; `src/background/tabState.ts`; `src/lib/analyze.ts`. The 256 MB per-segment and 20 GB total caps are conservative defaults, not tuned against real streams.
