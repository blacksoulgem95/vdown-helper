---
id: VDH-077
title: Desktop link: hand MSE captures and recordings to the app (push-bytes)
status: todo
priority: P2
area: desktop
depends_on: [VDH-067, VDH-068]
---

# VDH-077: Desktop link: hand MSE captures and recordings to the app (push-bytes)

## Description

Captures of MediaSource players and recordings of MediaStreams happen in the page (the bytes exist only there). Pass
them to the desktop app over the link as they arrive (`push-bytes { jobId, seq, chunk, last }`), so the app joins and,
when the user picks it, re-encodes them on disk instead of in browser memory.

## Acceptance criteria

- [ ] `push-bytes` in protocol v1, with ordering, back-pressure and a size cap; the app refuses bytes for a job it did
      not accept
- [ ] A capture and a recording handed to the app produce files that pass ffprobe and a full decode
- [ ] Protected playback is still refused before any byte is captured (the extension's own checks)
- [ ] Extension <-> app E2E in real Chromium
- [ ] CI green on the PR head

## Notes

- Split from VDH-067.
