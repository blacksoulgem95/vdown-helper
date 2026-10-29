---
id: VDH-065
title: Desktop engine and CLI: fetching, HLS/DASH/AES-128, live recording, native ffmpeg
status: in-progress
priority: P1
area: desktop
depends_on: [VDH-063]
---

# VDH-065: Desktop engine and CLI: fetching, HLS/DASH/AES-128, live recording, native ffmpeg

## Description

`vdh-engine`: the app's download manager, usable from a `vdh` CLI for tests. Fetches with the system proxy, Referer/Origin/UA
from the hand-off and in-memory cookies; refuses DRM with `vdh-core`'s verdicts; writes to disk, so no size limit.

## Acceptance criteria

- [x] HLS (incl. AES-128, TS and fMP4) and DASH staged to disk with concurrent segments; live HLS recording (stop keeps
      what was recorded); plain files streamed
- [x] Remux, merge separate audio+video, audio extract/convert via ffmpeg as a separate program with argument vectors from
      `vdh-core` only (no shell); progress from `-progress pipe:1`
- [x] Requests re-planned and re-checked by the engine (a forged request naming a DRM stream is refused); standalone
      addresses probed into the same resource the extension builds, then `vdh-core` builds the request
- [x] `vdh` CLI (`probe`, `get`, `run`); integration tests against the E2E fixture servers: outputs checked with ffprobe +
      full decode, DRM fixtures refused, Referer replay, live end and stop
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- Split: the persistent queue (SQLite, pause/resume/retry, resume after `kill -9`, bandwidth cap, schedule, history) is
  VDH-075, so this PR stays reviewable.
- HTTP: reqwest with rustls and the operating system's certificate store, the system proxy; redirects only to http(s);
  cookies only for the origin they were given for (memory only; reqwest drops them on a cross-host redirect).
- ffmpeg: `VDH_FFMPEG` or `ffmpeg` on the PATH for now; the bundled build comes with packaging (VDH-069).
- `vdh-core` gained an opt-in `progress` flag in the ffmpeg arguments (`-nostats -progress pipe:1`); the extension does
  not set it.
- The fixture tests run in CI on Linux (`engine-fixtures` job, `VDH_REQUIRE_FIXTURES=1`); on other systems they skip
  when node or ffmpeg is missing.
