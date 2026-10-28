---
id: VDH-065
title: Desktop engine and CLI: fetching, HLS/DASH/AES-128, live, native ffmpeg remux, resumable queue
status: todo
priority: P1
area: desktop
depends_on: [VDH-063]
---

# VDH-065: Desktop engine and CLI: fetching, HLS/DASH/AES-128, live, native ffmpeg remux, resumable queue

## Description

`vdh-engine`: the app's download manager, usable from a `vdh` CLI for tests. Fetches with the system proxy, Referer/Origin/UA
from the hand-off and in-memory cookies; refuses DRM with `vdh-core`'s verdicts; writes to disk, so no size limit.

## Acceptance criteria

- [ ] HLS (incl. AES-128) and DASH staged to disk with concurrent segments; live HLS recording
- [ ] Remux, merge separate audio+video, audio extract/convert via a sidecar ffmpeg with argument vectors from `vdh-core` only (no shell); progress from `-progress`
- [ ] Persistent SQLite queue: pause/resume/retry, resume after `kill -9` gives an identical file; bandwidth cap; schedule window; history with redacted URLs
- [ ] Integration tests against `e2e/server.mjs` fixtures: outputs checked with ffprobe + full decode; DRM fixtures refused
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
