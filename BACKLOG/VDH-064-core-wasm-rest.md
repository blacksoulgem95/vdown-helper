---
id: VDH-064
title: Rust core: the remaining pure modules
status: done
priority: P2
area: lib
depends_on: [VDH-063]
---

# VDH-064: Rust core: the remaining pure modules

## Description

Last slice: `resources`, `queue`, `zip`, `subtitles`, `subtitleBytes`, `media`, `metadata`, `mse`, `mseParts`, `hookData`,
`replay`, `dataUrl`, `tabs` and the release version logic.

## Acceptance criteria

- [x] All listed modules run from Rust (exceptions in Notes); no pure logic left duplicated in TS
- [x] Goldens recorded from the former TypeScript (`core/fixtures/golden/{ui,page,subtitles,mse}.jsonl`, ~4,800 cases
      incl. a corpus with the E2E fixtures' real subtitles and fMP4/WebM segments) match in `cargo test` and through the
      wasm; existing unit suites pass
- [x] Full local suite (incl. E2E) green
- [x] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- Stays in TypeScript, on purpose:
  - `dataUrl`: the page scripts use it and never load the core (VDH-071). The core has its own copy
    (`core/src/data_url.rs`); `tests/core-golden.test.ts` holds both to the same recorded answers.
  - `scripts/lib/version.ts`: release-pipeline logic run by Node in CI, not app logic. VDH-069 extends it for
    `desktop-v` tags.
  - `buildReplayRule` (a `chrome.declarativeNetRequest` rule) and the `TAB_ORDER` / format-set / stage constants (data,
    checked against the core by a test).
- Not in this task: `analyze.ts` (candidates to resources) and `classify.ts` are pure too and still TypeScript: VDH-074.
- Records passed whole (resources, jobs) cross as JSON values, so unknown fields pass through like `{ ...a, ...b }`. A
  property set to `undefined` arrives as `null`, which the core reads as `undefined`; results never hold `null`.
  Functions that return the caller's own objects (ranking, grouping, hiding covered variants, splitting by tab, frame
  groups, the popup queue, unchanged verdicts) get indexes from the core, so object identity is kept.
- `SpeedMeter` and `ChunkClassifier` keep their small state in TypeScript and advance it through pure core functions
  (nothing to free on the wasm side).
- Windows-1252: Node, where the goldens were recorded, decodes it as ISO-8859-1 (0x80 is a control character); Chrome
  and the core follow the Encoding Standard (0x80 is "€"). The few golden lines involved were corrected to the standard.
- Golden recording details: byte arrays created in the jsdom realm were serialised as plain objects and were normalised
  to `{ $bytes }`; the two size-limit cases (1 MB JSON-LD, 2 MB feed) are left out of the fixtures and stay covered by
  the unit tests, which now run through the wasm. serde_json reads the fixtures with `float_roundtrip` (tests only):
  the default parser can be one ulp off.
- JSON-LD nested deeper than 128 levels is not read (serde_json's recursion limit); the TypeScript read its top 6 levels.
- Size: the wasm is ~1074 KB (VDH-072). An MSE chunk is copied into wasm memory to be classified, so that memory grows
  to the largest chunk seen.
- Verified on `c4b2e80` (PR #15): local suite (unit 674/674, cargo, E2E 113/113) and CI runs 40801271526 / 40802098555
  (`check`, `e2e`) and 40801271553 / 40802097021 (Desktop).
