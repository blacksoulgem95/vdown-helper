---
id: VDH-074
title: Rust core: candidate analysis (analyze, classify)
status: todo
priority: P2
area: lib
depends_on: [VDH-064]
---

# VDH-074: Rust core: candidate analysis

## Description

`src/lib/analyze.ts` (raw candidates to resources: kinds, formats, verdicts, caps) and `src/lib/classify.ts` (what the
page scanner's raw facts are) are pure and still TypeScript; only their DRM verdicts moved in VDH-062. The desktop
app's page scan (VDH-066) needs the same decisions, so they move to the core like the other modules.

## Acceptance criteria

- [ ] `provisionalResources`, `classifyCandidates` and their helpers run from Rust behind unchanged TS exports
- [ ] Goldens recorded from the former TypeScript match in `cargo test` and through the wasm; unit suites pass
- [ ] Full local suite (incl. E2E) and CI green

## Notes

- Found while doing VDH-064, whose list did not include them.
