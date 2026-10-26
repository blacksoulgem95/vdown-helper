---
id: VDH-011
title: HLS segment downloader (offscreen document)
status: done
priority: P0
area: background
depends_on: [VDH-005, VDH-009]
---

# VDH-011: HLS segment downloader (offscreen document)

## Description

Offscreen document fetches playlist segments with bounded concurrency, retries with backoff, AbortController cancellation, init-map handling, AES-128 decryption through WebCrypto only when the key URI is fetchable under normal browser access. SAMPLE-AES and DRM key formats are flagged protected and blocked. Enforces the configurable memory guard (default 2 GB).

## Acceptance criteria

- [x] Segment-count progress is real
- [x] Cancel aborts in-flight fetches and frees memory
- [x] Over-limit jobs refused with a message referencing VDH-020
- [x] Encrypted streams: AES-128 decrypted when key accessible; DRM/SAMPLE-AES blocked with explanation
- [x] Verified against local fixture HLS in real Chromium

## Notes

E2E: ordered segment join (fully decodable), AES-128 (IV from sequence), cancel (no file), failure then retry, CORS-open CDN with wildcard ACAO, a 140 MB TS passthrough with a 128 MB limit (allowed, disk-backed) and the same stream as MP4 stopped by the memory guard.
