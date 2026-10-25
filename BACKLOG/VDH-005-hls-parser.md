---
id: VDH-005
title: HLS playlist parser
status: todo
priority: P0
area: lib
depends_on: [VDH-004]
---

# VDH-005: HLS playlist parser

## Description

Dedicated parser: `#EXTM3U`, `#EXT-X-STREAM-INF`, `#EXT-X-MEDIA`, `#EXTINF`, `#EXT-X-MAP`, `#EXT-X-KEY`, `#EXT-X-TARGETDURATION`, `#EXT-X-MEDIA-SEQUENCE`, `#EXT-X-ENDLIST`; relative/absolute URL resolution; classification into HLS master / HLS media / plain M3U / unsupported; encryption method detection (NONE, AES-128, SAMPLE-AES, DRM key formats).

## Acceptance criteria

- [ ] Master playlist yields only variants actually present, with bandwidth, resolution, frame rate and codecs when given
- [ ] Separate audio renditions exposed with group/language/URI
- [ ] Media playlist yields segments, durations, init map, sequence, endlist (VOD vs live)
- [ ] Plain `.m3u` is not classified as HLS
- [ ] Malformed input returns a typed error, never throws unhandled
- [ ] Unit tests incl. relative URLs and invalid manifests

## Notes

_None yet._
