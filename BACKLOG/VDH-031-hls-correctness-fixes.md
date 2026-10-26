---
id: VDH-031
title: HLS correctness: encrypted init sections, ignored Range, unusable keys
status: done
priority: P1
area: lib
depends_on: [VDH-011]
---

# VDH-031: HLS correctness: encrypted init sections, ignored Range, unusable keys

## Description

Review findings: AES-128 fMP4 init sections were not decrypted; servers that ignore Range corrupted byte-range playlists; an AES-128 key with a non-http(s) URI looked downloadable and failed after the first segment; the audio rendition was not checked for DRM/live in the background; extension-less media URLs were saved as ".unkno".

## Acceptance criteria

- [x] The key in effect at EXT-X-MAP decrypts the init section (E2E with an encrypted fMP4 fixture)
- [x] A 200 response to a Range request is sliced to the requested range (E2E with a Range-ignoring server), a wrong-length 206 is rejected
- [x] AES-128 without a fetchable key URI is classified protected before any download
- [x] `submit()` also inspects the audio rendition for DRM/live
- [x] Unknown formats get no made-up extension: the MIME type decides, otherwise Chrome names the file

## Notes

Regression tests in `tests/review-regressions.test.ts` plus the three new E2E steps.
