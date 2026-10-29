---
id: VDH-063
title: Rust core: planner, ffmpeg arguments, requests, settings, security, file types, sniffing
status: in-progress
priority: P1
area: lib
depends_on: [VDH-062]
---

# VDH-063: Rust core: planner, ffmpeg arguments, requests, settings, security, file types, sniffing

## Description

Second slice of the port: the decisions (what may be saved and how) and the security helpers.

## Acceptance criteria

- [ ] `compat`, `ffmpegArgs`, `request`, `settings`, `security`, `filetypes`, `sniff` run from Rust behind unchanged TS exports
- [ ] Conformance: existing unit tests pass against the wasm; Rust tests on the shared fixtures
- [ ] Full local suite and CI green
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
