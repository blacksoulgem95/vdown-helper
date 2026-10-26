---
id: VDH-034
title: MPEG-DASH support
status: todo
priority: P0
area: lib
depends_on: [VDH-033]
---

# VDH-034: MPEG-DASH support

## Description

Parse MPD manifests (Period/AdaptationSet/Representation, SegmentTemplate number/time/timeline, SegmentList, SegmentBase+sidx, BaseURL, multi-period, static/dynamic), show variants and audio tracks like HLS, download segments with the shared segment engine and merge with FFmpeg. ContentProtection: Widevine/PlayReady/FairPlay refused; ClearKey with an openly delivered key allowed.

## Acceptance criteria

- [ ] Parser unit tests for every addressing mode, multi-period and base URL resolution
- [ ] DASH card lists real representations only; size is an estimate
- [ ] Video+audio merged to MP4/MKV, valid and decodable (E2E with dash.js fixtures)
- [ ] Protected manifests are refused with a clear reason (unit + E2E)
- [ ] ClearKey stream decrypts when the key is openly fetchable

## Notes

_None yet._
