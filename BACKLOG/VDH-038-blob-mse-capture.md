---
id: VDH-038
title: Blob files and MSE capture
status: todo
priority: P0
area: content
depends_on: [VDH-033]
---

# VDH-038: Blob files and MSE capture

## Description

Read real Blob sources from the page. For MSE players, first discover the real manifest via the hook; when none exists, record what the player appends (fast capture with a visible banner, or real-time), mux it and save. EME/protected playback is refused.

## Acceptance criteria

- [ ] Real Blob URLs download correctly
- [ ] hls.js and dash.js players inside iframes are resolved through manifest discovery
- [ ] Recording fallback produces a decodable file (fast and real-time)
- [ ] A visible, cancellable banner shows while the page is manipulated, and playback state is restored
- [ ] EME-protected video is refused and never recorded
- [ ] A resolution switch during capture yields parts, never a re-encode

## Notes

_None yet._
