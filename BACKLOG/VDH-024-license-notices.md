---
id: VDH-024
title: License and third-party notices
status: done
priority: P2
area: docs
depends_on: [VDH-012]
---

# VDH-024: License and third-party notices

## Description

MIT `LICENSE` for project code, `THIRD_PARTY_NOTICES.md` listing FFmpeg core (GPL) and npm dependencies; README flags that distributing the combined package needs the owner's legal confirmation.

## Acceptance criteria

- [x] LICENSE and notices present
- [x] FFmpeg core licence stated accurately after checking the installed package

## Notes

`package.json` of `@ffmpeg/core` declares GPL-2.0-or-later. Whether the combined package is acceptable for store distribution is explicitly left to the project owner in THIRD_PARTY_NOTICES.md.
