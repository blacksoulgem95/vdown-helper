---
id: VDH-045
title: ClearKey / CENC decryption for DASH
status: todo
priority: P3
area: lib
depends_on: [VDH-034]
---

# VDH-045: ClearKey / CENC decryption for DASH

## Description

DASH streams encrypted with ClearKey (keys delivered in the clear, not DRM) are detected and labelled, but cannot be downloaded: the key is neither requested nor applied. Implementing it needs: a licence request to the manifest's `Laurl` (and the keys the page's own player passes to `MediaKeySession.update`, via the hook), a CENC (AES-CTR / `cenc` scheme) decryptor for fragmented MP4 (parse `moof/traf/senc/trun`, decrypt samples, handle subsamples), and a test fixture generator. ffmpeg's own CENC muxer output is not decryptable even by ffmpeg ("saio atom found without saiz"), so fixtures must come from an independent encryptor written for the tests.

Real DRM (Widevine, PlayReady, FairPlay) stays refused and is out of scope.

## Acceptance criteria

- [ ] A ClearKey DASH stream with an openly obtainable key downloads and decodes correctly
- [ ] Streams whose key cannot be obtained, and any real DRM, are refused with a clear reason
- [ ] CENC decryption is unit-tested against an independently generated fixture (subsamples and whole-sample)

## Notes

Not started. Low priority: ClearKey is rare in the wild.
