---
id: VDH-081
title: 'Desktop Opus output: FFmpeg 8 native decoder rejects packets from libopus 1.6'
status: todo
priority: P3
area: desktop
depends_on: [VDH-068]
---

# VDH-081: Desktop Opus output: FFmpeg 8 native decoder rejects packets from libopus 1.6

## Description

On the CI runner (Ubuntu 26.04: FFmpeg 8.0.1, libopus 1.6.1), decoding a re-encode's Opus track with FFmpeg's own
Opus decoder reports `Error parsing Opus packet header`; libopus (the reference decoder, used by browsers) decodes
the same file without errors, and FFmpeg 6.1 with its libopus decodes it cleanly too. Find out which packets are
rejected (all, or only some such as the last one) and whether an encoder option (or the pinned ffmpeg build of
VDH-069) avoids it, so players built on FFmpeg's decoder (mpv, ffplay) play the files without errors.

## Acceptance criteria

- [ ] The rejected packets identified on FFmpeg 8 + libopus 1.6 (which, and why)
- [ ] Opus output that FFmpeg's native decoder and libopus both decode without errors, or a documented reason why
      not, with the engine tests decoding Opus with both decoders
- [ ] CI green on the PR head

## Notes

- Found by `engine-fixtures` on PR #20 (VDH-068); meanwhile the engine tests decode Opus with libopus.
