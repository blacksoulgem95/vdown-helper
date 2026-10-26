---
id: VDH-034
title: MPEG-DASH support
status: done
priority: P0
area: lib
depends_on: [VDH-033]
---

# VDH-034: MPEG-DASH support

## Description

Parse MPD manifests (Period/AdaptationSet/Representation, SegmentTemplate number/time/timeline, SegmentList, SegmentBase+sidx, BaseURL, multi-period, static/dynamic), show variants and audio tracks like HLS, download segments with the shared segment engine and merge with FFmpeg. ContentProtection: Widevine/PlayReady/FairPlay refused; ClearKey with an openly delivered key allowed.

## Acceptance criteria

- [x] Parser unit tests for every addressing mode, multi-period and base URL resolution
- [x] DASH card lists real representations only; size is an estimate
- [x] Video+audio merged to MP4/MKV, valid and decodable (E2E with dash.js fixtures)
- [x] Protected manifests are refused with a clear reason (unit + E2E)
- [ ] ClearKey stream decrypts when the key is openly fetchable (moved to VDH-045; detected and labelled, not downloadable)

## Notes

Implemented: a safe XML reader (`src/lib/xml.ts`: no DTD/entity expansion, size/depth limits; the service worker has no DOMParser), the MPD parser (`src/lib/dash/parser.ts`: Period/AdaptationSet/Representation, SegmentTemplate with $Number$/$Time$ and timelines incl. r=-1, SegmentList with ranges, SegmentBase/BaseURL single file, nested BaseURLs, multi-period, static/dynamic, ContentProtection classification), analysis into the same variant/audio model as HLS, request building, planning (reuses the HLS merge/remux rules), background inspection, and download through the shared segment engine (`stageSegmentList`, now also used by HLS).

Verified in real Chromium against an ffmpeg-generated manifest (E2E, 53 steps): real representations only (360p/180p, one AAC track), estimated size, quick DOWNLOAD merges to a valid decodable H.264/AAC MP4 (MERGING, no re-encode), the Studio's 180p choice downloads that representation (width 320), audio-only copies the AAC track to M4A, a Widevine manifest and a live manifest are refused (UI and background), plain empty MPDs are "malformed".

Known limits: multi-period manifests download only the longest period (shown to the user via the period count); WebM-in-DASH is not specifically handled; live manifests are detected and refused until VDH-040.
ClearKey: see VDH-045.
