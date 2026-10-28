---
id: VDH-068
title: Desktop re-encoding: presets, codec controls, trim, MKV, soft subtitles, batch
status: todo
priority: P2
area: desktop
depends_on: [VDH-066]
---

# VDH-068: Desktop re-encoding: presets, codec controls, trim, MKV, soft subtitles, batch

## Description

Optional video re-encoding in the app only (the extension never re-encodes video). Bundled GPL ffmpeg (x264/x265) plus hardware
encoders when present.

## Acceptance criteria

- [ ] Presets and codec/resolution/quality/bitrate controls; hardware encoders detected by a test encode
- [ ] Trim with preview player, timeline and keyframe snapping (lossless when possible)
- [ ] MKV output; subtitles downloaded, converted and embedded as soft subs
- [ ] Batch re-encode of finished or local files; E2E checks outputs with ffprobe
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
