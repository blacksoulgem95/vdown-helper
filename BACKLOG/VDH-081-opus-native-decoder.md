---
id: VDH-081
title: Desktop Opus re-encodes: FFmpeg 8 logs an error at the last Opus packet from Matroska
status: done
priority: P2
area: desktop
depends_on: [VDH-068]
---

# VDH-081: Desktop Opus re-encodes: FFmpeg 8 logs an error at the last Opus packet from Matroska

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
      out of that WebM decodes cleanly again. The fault is in FFmpeg 8.0.1's reading of Opus from Matroska, not in
      the stored data: the error is logged whenever the packet is read, already while ffmpeg looks at the streams and
      even when the audio is dropped (`-discard:a all`) or not decoded
- [x] The engine tests check every packet of a Matroska/WebM output with Opus: the video and the Opus packets are
      copied unchanged into files of their own (Matroska without the Opus, and Ogg) and each is decoded in full
- [x] CI green on the PR head

## Notes

- Found by `engine-fixtures` on PR #20 (VDH-068), narrowed down there with temporary CI-only tests (removed again).
- FFmpeg 6.1 (Ubuntu 24.04) reads the same files cleanly. The message has the wording of FFmpeg's Opus parser, which
  the Matroska demuxer runs on every packet: players built on FFmpeg 8.0 may log it once at the end of such a file;
  browsers read WebM with their own demuxer and libopus.
- When VDH-069 pins the app's ffmpeg, check the pinned build against the same test.
- Done: `engine-fixtures` green on FFmpeg 8.0.1 in CI runs 40831516844 and 40831511667 (Desktop), 40831516905 and 40831511843 (check, e2e) on `1110509`.
