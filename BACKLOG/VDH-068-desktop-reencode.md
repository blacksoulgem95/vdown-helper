---
id: VDH-068
title: Desktop re-encoding: presets, codec controls, hardware encoders, MKV, batch
status: done
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

- [x] Presets and codec/resolution/quality/bitrate controls; hardware encoders detected by a test encode
- [x] MKV (and WebM) output, with the codec/container combinations checked before anything runs
- [x] Batch re-encode of finished or local files, as queue jobs (pause, cancel, retry like any job)
- [x] Engine tests and the app E2E check the outputs with ffprobe (codec, size, a full decode)
- [x] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- `vdh-core::transcode`: the closed encode set, `check()` codes, argument vectors (one argument per value, no shell),
  presets, the short label and the one-frame test encode. `vdh-engine`: `encoders::detect`, `reencode::run` (staged and
  moved into place; the original is only read), `Manager::add_reencode`; `vdh encode` / `vdh encoders` /
  `vdh queue add-encode`. App: `presets`, `encoders` (detected once), `check_encode`, `pick_files`, `reencode` (only
  files the queue finished or the user picked), the Convert tab and **Re-encode** in the History; notifications say
  "Re-encode finished" / "failed".
- The manager now announces a finished job before removing it from the queue, so the app can tell a re-encode from a
  download in its notification.
- Verified locally: `cargo test` (incl. `tests/reencode.rs`: H.265 MKV, VP9 WebM at 144p, a remux, refusals, a batch
  in the queue with its history, a paused encode resumed to the end), the desktop E2E 10/10 (re-encode to H.265 MKV
  with the original unchanged and its notification, a batch with the Compatible preset; codecs checked with ffprobe).
  Hardware encoders are covered by argument tests only: no GPU on the runners.
- Done: CI runs 40831516844 and 40831511667 (Desktop), 40831516905 and 40831511843 (check, e2e) on `1110509`, all green; the full local suite (incl. `test:e2e`, `test:desktop`, `test:link`, cargo) green on
  the same head. Found on the way: VDH-081 (FFmpeg 8 and Opus in Matroska) and the cause of VDH-078.
