---
id: VDH-039
title: MediaStream recording
status: todo
priority: P1
area: content
depends_on: [VDH-038]
---

# VDH-039: MediaStream recording

## Description

Record video.srcObject MediaStreams (camera, screen share, WebRTC, canvas) with MediaRecorder: WebM, or MP4 where Chrome supports it; Stop button; audio-only through the existing audio pipeline.

## Acceptance criteria

- [ ] MediaStream sources are detected and offer Record/Stop
- [ ] Output plays and is decodable (E2E with a canvas stream)
- [ ] Recording indicator is visible; limits are enforced
- [ ] Protected streams are refused

## Notes

_None yet._
