---
id: VDH-072
title: Trim the shared core's wasm (about 1 MB, inlined in every extension page)
status: todo
priority: P2
area: build
depends_on: [VDH-063]
---

# VDH-072: Trim the shared core's wasm

## Description

The wasm grew to about 840 KB with VDH-063 (Unicode normalisation tables for NFC/NFKD, IDNA tables from `url`,
`serde_json`) and to about 1074 KB with VDH-064. It is inlined as base64 in the service worker, the offscreen document and each extension page, and
compiled every time a page opens. Page scripts carry none of it (VDH-071).

## Acceptance criteria

- [ ] Measure where the bytes go (`twiggy` or similar)
- [ ] Run `wasm-opt -Oz` in `scripts/build-core.mjs` with a pinned binaryen (no network at build time beyond npm)
- [ ] Remove avoidable weight (e.g. `serde_json` in the wasm build, unused normalisation forms) without changing results
      (goldens still match)
- [ ] Popup open time measured before/after in the E2E browser

## Notes
