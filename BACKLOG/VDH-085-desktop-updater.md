---
id: VDH-085
title: Desktop auto-update (signed latest.json, install after the user confirms)
status: blocked
priority: P2
area: desktop
depends_on: [VDH-069]
---

# VDH-085: Desktop auto-update (signed latest.json, install after the user confirms)

## Description

The Tauri updater: at start (toggle in Settings) the app checks the latest release's signed `latest.json` and offers
the update; it installs only after the user confirms. `.deb` / `.rpm` installs only notify, with a link. The one
network call that is not media the user chose (CLAUDE.md desktop exceptions): GitHub only, no identifiers.

## Acceptance criteria

- [ ] Updater artifacts signed in the release workflow; `latest.json` attached to each release
- [ ] Settings toggle (on by default), confirmation dialog, en/it
- [ ] An update from an older build to a newer one checked on Linux (AppImage)
- [ ] CI green on the PR head

## Notes

- Blocked on the owner: generate the key pair (`npx @tauri-apps/cli signer generate -w ~/.tauri/vdown-helper.key`),
  add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as repository secrets, and share the public
  key (it goes into the app's configuration).
