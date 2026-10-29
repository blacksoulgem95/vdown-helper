---
id: VDH-063
title: Rust core: planner, ffmpeg arguments, requests, settings, security, file types, sniffing
status: done
priority: P1
area: lib
depends_on: [VDH-062, VDH-071]
---

# VDH-063: Rust core: planner, ffmpeg arguments, requests, settings, security, file types, sniffing

## Description

Second slice of the port: the decisions (what may be saved and how), the request builders and their validation, and the
security helpers. With VDH-071 the page scripts no longer use any of these, so they can all move into the core.

## Acceptance criteria

- [x] `compat` (planner), `ffmpegArgs`, `request` (choices, builders, plan dispatch, `sanitizeRequest`), `settings`
      (validation, migration, quality pick), `security` (URL checks, redaction, file names, name template), `filetypes`
      and `sniff` run from Rust behind unchanged TS exports; what needs `chrome.*` or `URL` objects stays TS
- [x] Goldens recorded from the former TypeScript (`core/fixtures/golden/{files,planner,requests}.jsonl`, ~7,000 cases incl.
      a combinatorial planner corpus) match in `cargo test` and through the wasm; existing unit suites pass;
      `DEFAULT_SETTINGS`/`LIMITS` checked against the core
- [x] Page scripts still carry no core (`check:dist`); full E2E green
- [x] CI green on the PR head

## Notes

- Functions that put the date in a file name take `today` from the TS wrapper: the core has no clock.
- `normalizeUrl` sorts query parameters by code point; the TypeScript used `localeCompare` (ICU collation). Only the
  deduplication key's shape can differ (mixed case or punctuation in parameter names); the goldens matched as recorded.
- `sanitizeRequest` works on the JSON object, so fields it does not touch pass through as with `...req`; a JavaScript
  `undefined` property is treated as absent. A request whose `filename`/`sourceUrl`/`subfolder` is not a string is
  refused (the TypeScript threw).
- Size: the wasm is ~840 KB (Unicode normalisation tables for NFC/NFKD, serde_json). Trimming is VDH-072.
- Verified on `60bbb4b` (PR #14): local suite (unit 664/664, cargo, E2E 113/113) and CI runs 40795079552 / 40795917797
  (`check`, `e2e`) and 40795079828 / 40795917824 (Desktop).
