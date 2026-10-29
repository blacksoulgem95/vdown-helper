---
id: VDH-081
title: 'Desktop Opus re-encodes do not decode on FFmpeg 8 + libopus 1.6'
status: in-progress
priority: P1
area: desktop
depends_on: [VDH-068]
---

# VDH-081: Desktop Opus re-encodes do not decode on FFmpeg 8 + libopus 1.6

## Description

On the CI runner (Ubuntu 26.04: FFmpeg 8.0.1, libopus 1.6.1), the Opus track of a re-encode (the Web and Archive
presets: VP9/WebM, AV1/MKV) fails a full decode with `Error parsing Opus packet header`, with FFmpeg's own Opus decoder
**and** with libopus. The same encodes decode cleanly with FFmpeg 6.1 / libopus 1.4 (Ubuntu 24.04). Find which packets
are rejected and why, and make the app write Opus that decodes everywhere (an encoder option, or the pinned ffmpeg
build of VDH-069), since the Opus presets would otherwise write broken audio with such a build.

## Acceptance criteria

- [ ] The rejected packets identified on FFmpeg 8 + libopus 1.6 (which, and why)
- [ ] Opus output that decodes without errors there, checked by the engine tests (full decode)
- [ ] CI green on the PR head

## Notes

- Found by `engine-fixtures` on PR #20 (VDH-068). Decoding with libopus instead of FFmpeg's decoder did not help (the
  same error), so the packets themselves are rejected; the engine tests now print, on a failed decode, the lines
  before the first errors (`-debug_ts`) and the audio packets, to find out which.
