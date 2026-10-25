---
id: VDH-011
title: HLS segment downloader (offscreen document)
status: todo
priority: P0
area: background
depends_on: [VDH-005, VDH-009]
---

# VDH-011: HLS segment downloader (offscreen document)

## Description

Offscreen document fetches playlist segments with bounded concurrency, retries with backoff, AbortController cancellation, init-map handling, AES-128 decryption through WebCrypto only when the key URI is fetchable under normal browser access. SAMPLE-AES and DRM key formats are flagged protected and blocked. Enforces the configurable memory guard (default 2 GB).

## Acceptance criteria

- [ ] Segment-count progress is real
- [ ] Cancel aborts in-flight fetches and frees memory
- [ ] Over-limit jobs refused with a message referencing VDH-020
- [ ] Encrypted streams: AES-128 decrypted when key accessible; DRM/SAMPLE-AES blocked with explanation
- [ ] Verified against local fixture HLS in real Chromium

## Notes

_None yet._
