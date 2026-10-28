---
id: VDH-070
title: Pin the extension ID with the owner's public key
status: in-progress
priority: P1
area: build
depends_on: [VDH-061]
---

# VDH-070: Pin the extension ID with the owner's public key

## Description

VDH-061 pinned the extension ID with a key generated for the purpose. The owner supplied the public key the package must
use, so the extension ID (and the native host's `allowed_origins`) follows it: `jplegcfjmgefcabmhljkgneehmgfhclk`.

## Acceptance criteria

- [ ] `manifest.json` `key` is the owner's public key; `scripts/lib/extension-id.mjs` and `core/src/link.rs` name the ID it
      gives (`check:dist` and `cargo test` assert they agree)
- [ ] E2E loads the build under that ID
- [ ] CI green on the PR head

## Notes

- The ID derived from the key: sha256 of the DER SubjectPublicKeyInfo, first 32 hex digits mapped to a-p.
- The private half stays with the owner; it is never in the repository. The key generated in VDH-061 is no longer used.
- Unpacked installs of 1.3.x get a new ID once more (settings stored under the previous ID start fresh).
