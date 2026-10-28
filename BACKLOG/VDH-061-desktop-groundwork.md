---
id: VDH-061
title: Desktop app groundwork: rules, design doc, pinned extension ID, Rust workspace and CI
status: done
priority: P1
area: build
depends_on: [VDH-020]
---

# VDH-061: Desktop app groundwork: rules, design doc, pinned extension ID, Rust workspace and CI

## Description

Start of the desktop client (Rust, Tauri v2, Windows/macOS/Linux). Scope agreed with the owner, recorded in `docs/desktop.md`.
This task lays the ground without shipping any user-facing feature.

## Acceptance criteria

- [x] `CLAUDE.md` carries the desktop exceptions: video re-encode only in the app on the user's choice; the update check is the one allowed non-media call; cookies go to the app for one job, in memory only; the app has no LAN guard (the extension's guard is unchanged)
- [x] `docs/native-companion.md` replaced by `docs/desktop.md` (architecture, protocol v1, host locations per OS and browser, security model); README and locale references updated
- [x] `manifest.json` has a `key`, so every unpacked install has the same extension ID; E2E and store-assets use that ID; the private key is handed to the owner, never committed
- [x] Cargo workspace (`core/` crate skeleton) with `cargo fmt`, `clippy -D warnings` and `cargo test` in CI on Linux, Windows and macOS
- [x] Extension release ignores `desktop/**`; full local suite and CI green on the PR head
- [x] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.

- Verified: local suite (E2E 113/113) on a9d64c1; CI on PR #10 green: CI runs 40622400239 and 40622404968 (check, e2e), Desktop runs 40622400375 and 40622405037 (rust on Linux, Windows, macOS).
