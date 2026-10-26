---
id: VDH-043
title: Realistic test players and fixtures
status: done
priority: P1
area: test
depends_on: [VDH-033]
---

# VDH-043: Realistic test players and fixtures

## Description

Dev-only hls.js and dash.js in local fixture pages, nested cross-origin iframes on 127.0.0.x origins, Referer-gated and ranged servers, mock open-site APIs. Never shipped in the extension.

## Acceptance criteria

- [x] hls.js and dash.js produce genuine blob/MSE playback in fixtures (E2E `real hls.js / dash.js player in a cross-origin frame`: the real players, served from node_modules, play VP9/Opus fMP4 through MediaSource)
- [x] Nested iframe fixtures on three origins (A -> C -> D on 127.0.0.1/.2/.3, plus a Referer-gated file, a ranged and a stalled server, live-stream clocks, a PeerTube-shaped instance and a podcast feed)
- [x] Dev dependencies are not in dist (check-dist asserts it; the assertion was seen to fire on an injected marker)

## Notes

- The players are served from `node_modules` by the test server only (`/__lib/...`), on every origin, so nested frames load their own copy. Licences are listed in `THIRD_PARTY_NOTICES.md` (development-only section).
- Chromium for Testing has no proprietary codecs, so the MSE fixtures are VP9 + Opus in fragmented MP4; H.264/AAC pages are covered by the parsers' unit tests (real ffmpeg output) and by VDH-028.
