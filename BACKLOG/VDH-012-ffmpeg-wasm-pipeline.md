---
id: VDH-012
title: FFmpeg.wasm processing pipeline
status: in-progress
priority: P1
area: background
depends_on: [VDH-011]
---

# VDH-012: FFmpeg.wasm processing pipeline

## Description

Bundle `@ffmpeg/ffmpeg` + `@ffmpeg/core` locally (no remote fetch). Operations: concat/remux TS to MP4, merge separate video + audio, extract audio (M4A/AAC copy when source is AAC, else transcode; MP3/WAV transcode with 128/192/256/320 kbps), progress reporting, cancellation, CPU/memory warnings. Verify CSP `wasm-unsafe-eval` and licensing; document in `THIRD_PARTY_NOTICES.md`.

## Acceptance criteria

- [ ] UI labels copy vs transcode accurately
- [ ] Unsupported combinations rejected before job start
- [ ] MERGING/ENCODING progress derived from ffmpeg progress events
- [ ] Output verified playable (ffprobe or Chromium) for TS->MP4, merge, MP3/WAV
- [ ] Single-thread core used (no SharedArrayBuffer/COOP requirement), documented

## Notes

Implemented: `src/offscreen/ffmpeg.ts` (WORKERFS mounts, single-flight), `src/lib/ffmpegArgs.ts` (tested). Core bundled from node_modules by `scripts/build.mjs`. Needs E2E verification of the wasm load, MP3/WAV/M4A outputs and CSP.
