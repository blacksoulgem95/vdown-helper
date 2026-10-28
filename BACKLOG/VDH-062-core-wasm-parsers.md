---
id: VDH-062
title: Rust core compiled to wasm: loader in every extension context; HLS, DASH, XML, DRM verdicts, inspection
status: todo
priority: P1
area: lib
depends_on: [VDH-061]
---

# VDH-062: Rust core compiled to wasm: loader in every extension context; HLS, DASH, XML, DRM verdicts, inspection

## Description

Every pure module of `src/lib` moves to the Rust crate `vdh-core`, compiled to wasm for the extension and used natively by the
desktop app, so the DRM rules and parsers have one implementation. First slice: the loader and the stream parsers.

## Acceptance criteria

- [ ] `core-wasm` built by `npm run build` (wasm-pack), loaded asynchronously in the service worker (listeners still registered synchronously), offscreen document, popup, side panel and options
- [ ] `hls/`, `xml`, `dash/`, `analyze` DRM verdicts and `inspect` run from Rust; the TS modules are thin wrappers with the same exports
- [ ] Types generated from Rust (`tsify`); the existing vitest suites pass against the wasm; golden fixtures give the same JSON in `cargo test`
- [ ] `check:dist` asserts the wasm is present and nothing remote is loaded; full E2E green
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
