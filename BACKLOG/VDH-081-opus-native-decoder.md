---
id: VDH-081
title: 'Desktop Opus re-encodes: FFmpeg 8 fails on the last Opus packet from Matroska'
status: in-progress
priority: P2
area: desktop
depends_on: [VDH-068]
---

# VDH-081: Desktop Opus re-encodes: FFmpeg 8 fails on the last Opus packet from Matroska

## Description

On the CI runner (Ubuntu 26.04: FFmpeg 8.0.1, libopus 1.6.1), a full decode of a re-encode's Opus track in WebM or
MKV (the Web and Archive presets) reports `Error parsing Opus packet header`, with FFmpeg's own Opus decoder and with
libopus. Find which packets are rejected and whether the files the app writes are at fault.

## Acceptance criteria

- [x] The rejected packets identified: only the last one (the end-trimmed packet, with Matroska's DiscardPadding),
      once per file, with every encoder variant tried (VBR modes, frame sizes, application, resampling, channels,
      bitrates, FFmpeg's own Opus encoder) in WebM and MKV, never in Ogg
- [x] The files shown to be correct: the last packet read from the WebM is byte for byte the one read from Ogg, with
      the same skip-samples side data; the Ogg decodes cleanly, the WebM made from it fails, and the Ogg copied back
      out of that WebM decodes cleanly again. The fault is in FFmpeg 8.0.1's decoding of Opus from Matroska, not in
      the stored data
- [x] The engine tests check every Opus packet of a Matroska/WebM output: the rest of the file is decoded as it is and
      the Opus packets, copied unchanged into Ogg, are decoded there
- [ ] CI green on the PR head

## Notes

- Found by `engine-fixtures` on PR #20 (VDH-068), narrowed down there with temporary CI-only tests (removed again).
- FFmpeg 6.1 (Ubuntu 24.04) decodes the same files cleanly. Players that decode with FFmpeg 8.0's code may log one
  error for the last 20 ms of such a file; browsers read WebM with their own demuxer and libopus.
- When VDH-069 pins the app's ffmpeg, check the pinned build against the same test.
