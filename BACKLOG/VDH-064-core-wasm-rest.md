---
id: VDH-064
title: Rust core: the remaining pure modules
status: todo
priority: P2
area: lib
depends_on: [VDH-063]
---

# VDH-064: Rust core: the remaining pure modules

## Description

Last slice: `resources`, `queue`, `zip`, `subtitles`, `subtitleBytes`, `media`, `metadata`, `mse`, `mseParts`, `hookData`,
`replay`, `dataUrl`, `tabs` and the release version logic.

## Acceptance criteria

- [ ] All listed modules run from Rust; no pure logic left duplicated in TS
- [ ] Conformance tests pass; full local suite and CI green
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
