---
id: VDH-062
title: Rust core compiled to wasm: loader in every extension context; HLS, DASH, XML, DRM verdicts, inspection
status: done
priority: P1
area: lib
depends_on: [VDH-061]
---

# VDH-062: Rust core compiled to wasm: loader in every extension context; HLS, DASH, XML, DRM verdicts, inspection

## Description

Every pure module of `src/lib` moves to the Rust crate `vdh-core`, compiled to wasm for the extension and used natively by
the desktop app, so the DRM rules and parsers have one implementation. First slice: the loader, the stream parsers and the
verdicts built on them.

## Acceptance criteria

- [x] `npm run build` (and `npm test`, `npm run typecheck`) compile `core-wasm` with the pinned `wasm-bindgen` CLI; the
      wasm is inlined and instantiated synchronously in the service worker, offscreen document, pages and unit tests
- [x] `hls/`, `xml`, `dash/` (parser, segment expansion, protections, `#vdh-rep=` references), the media-playlist and
      DASH verdicts of `analyze` and `inspect` run from Rust; the TS modules are thin wrappers with the same exports
- [x] Golden fixtures recorded from the former TypeScript (`core/fixtures/golden/*.jsonl`) give the same results in
      `cargo test` (native) and in `tests/core-golden.test.ts` (wasm); the existing unit suites pass on the wasm
- [x] `check:dist` asserts the core is in the service worker; full E2E green in real Chromium
- [x] CI (`check`, `e2e`, `Desktop`) green on the PR head; the CI jobs that build the extension set up Rust, the wasm
      target and the pinned CLI (`.github/actions/setup-core`)

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- Deviation from the first design: no `tsify`. The TS types in `src/types` stay the contract; the golden replay on both
  sides holds Rust to them. The wasm is inlined and loaded synchronously instead of fetched asynchronously, so no
  caller had to change.
- `analyze.ts` keeps its async orchestration (network probes) in TypeScript; its pure decisions moved: the DASH
  description is now `dashResource(text, url)` (a patch), plus `mediaPlaylistVerdict`.
- JavaScript semantics reproduced in `core/src/js.rs`: `Number()`, `trim()`, `String(number)`, `Date.parse` for ISO 8601
  (a date-time without an offset is read as UTC; wasm has no local time zone), `encodeURIComponent` /
  `decodeURIComponent`, UTF-16 lengths.
- One test changed: `tests/dash.test.ts` compared init sections by identity (`s.map === e.init`); objects crossing the
  wasm boundary are copies, and production code compares them by value (`offscreen/hls.ts` keys on `uri|offset`).
- Size: the wasm is about 520 KB (URL/IDNA tables and serde). Worth trimming later (`wasm-opt`) if it matters.
- Open question for VDH-063/064: the modules the content scripts use (`dataUrl`, `filetypes`, `sniff`, `security.log`,
  `metadata`) run in every frame of every page; inlining the wasm there costs memory per frame.

- Verified: local suite (unit 657/657, cargo, E2E 113/113) on d5d66c9; CI on PR #11 green: CI runs 40660622813 and 40660652404 (check, e2e), Desktop runs 40660622553 and 40660652430 (rust on Linux, Windows, macOS).
