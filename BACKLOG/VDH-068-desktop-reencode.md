---
id: VDH-068
title: Desktop re-encoding: presets, codec controls, hardware encoders, MKV, batch
status: in-progress
priority: P2
area: desktop
depends_on: [VDH-066]
---

# VDH-068: Desktop re-encoding: presets, codec controls, hardware encoders, MKV, batch

## Description

Optional video re-encoding in the app only (the extension never re-encodes video), only when the user picks it:
presets and manual codec / encoder / quality / bitrate / size / audio controls, hardware encoders (NVENC, Quick Sync,
AMF, VideoToolbox, VAAPI) offered only when a test encode succeeds, MP4 / MKV / WebM output, and batch re-encoding of
finished downloads or local files. The ffmpeg argument vectors come from `vdh-core` (a closed set), never a shell.

Trim (preview player, timeline, keyframe snapping) moved to VDH-079; subtitles embedded as soft subs to VDH-080.

## Acceptance criteria

- [ ] Presets and codec/resolution/quality/bitrate controls; hardware encoders detected by a test encode
- [ ] MKV (and WebM) output, with the codec/container combinations checked before anything runs
- [ ] Batch re-encode of finished or local files, as queue jobs (pause, cancel, retry like any job)
- [ ] Engine tests and the app E2E check the outputs with ffprobe (codec, size, a full decode)
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
