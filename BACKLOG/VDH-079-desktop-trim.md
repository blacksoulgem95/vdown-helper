---
id: VDH-079
title: Desktop trim: preview player, timeline, keyframe snapping
status: todo
priority: P3
area: desktop
depends_on: [VDH-068]
---

# VDH-079: Desktop trim: preview player, timeline, keyframe snapping

## Description

Cut a finished or local file in the app: a preview player with a timeline, in and out points that snap to keyframes,
a lossless cut (stream copy) when both points are keyframes, and a re-encode of the edges otherwise.

## Acceptance criteria

- [ ] Preview player and timeline in the app's window; in/out points snap to keyframes (from ffprobe)
- [ ] Lossless cut when the points are keyframes; otherwise only the edges are re-encoded
- [ ] Outputs checked with ffprobe (duration within a frame of the chosen points) in the app E2E
- [ ] CI green on the PR head

## Notes

- Split from VDH-068.
