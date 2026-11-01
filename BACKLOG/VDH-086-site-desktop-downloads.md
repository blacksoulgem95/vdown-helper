---
id: VDH-086
title: Site: desktop app download section (per OS, from the latest release)
status: done
priority: P3
area: docs
depends_on: [VDH-069]
---

# VDH-086: Site: desktop app download section (per OS, from the latest release)

## Description

The GitHub Pages site (`site/`) gets a desktop section: what the app adds to the extension, and a download per OS
(Windows setup/MSI, macOS DMG, Linux AppImage/deb/rpm) linking the latest release's assets, with the unsigned-installer
notes, en/it.

## Acceptance criteria

- [x] Section with links that resolve to the latest release's installers
- [x] en/it, site checks green
- [x] CI green on the PR head

## Notes

- Split from VDH-069.
- The installers were released with the version in their names; they are now released under fixed names
  (`desktop/release-assets.json`, shared by `scripts/desktop/smoke-test.mjs` and the site build), so the site links
  `releases/latest/download/<name>`. The first release with those names is the one this PR's merge publishes.
- Done: merged in PR #24 (`1eba44d`) with every check green on `6b93f2d` and the full local suite green on that head
  (extension E2E 114/114). The release published from that merge carries every installer under its fixed name, and each
  `releases/latest/download/<name>` link the site uses answers (HTTP 206 for a one-byte range, after redirects); the
  Pages run 41349677046 deployed the site. The live page itself could not be fetched from this session (its host is
  not reachable here); its content is the template the site test checks.
