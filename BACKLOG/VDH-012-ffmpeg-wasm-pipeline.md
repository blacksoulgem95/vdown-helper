---
id: VDH-012
title: FFmpeg.wasm processing pipeline
status: done
priority: P1
area: background
depends_on: [VDH-011]
---

# VDH-012: FFmpeg.wasm processing pipeline

## Description

Bundle `@ffmpeg/ffmpeg` + `@ffmpeg/core` locally (no remote fetch). Operations: concat/remux TS to MP4, merge separate video + audio, extract audio (M4A/AAC copy when source is AAC, else transcode; MP3/WAV transcode with 128/192/256/320 kbps), progress reporting, cancellation, CPU/memory warnings. Verify CSP `wasm-unsafe-eval` and licensing; document in `THIRD_PARTY_NOTICES.md`.

## Acceptance criteria

- [x] UI labels copy vs transcode accurately
- [x] Unsupported combinations rejected before job start
- [x] MERGING/ENCODING progress derived from ffmpeg progress events
- [x] Output verified playable (ffprobe or Chromium) for TS->MP4, merge, MP3/WAV
- [x] Single-thread core used (no SharedArrayBuffer/COOP requirement), documented

## Notes

E2E with the real bundled core: MP4 remux (copy), merge of separate audio/video, MP3 transcode (bitrate verified ~128 kbps), WAV (pcm_s16le), AAC to M4A copy, and monotonic progress events (0.14 → 1.00) on a 5-minute encode. Core is single-threaded; no SharedArrayBuffer needed. See THIRD_PARTY_NOTICES.md for the GPL question.
