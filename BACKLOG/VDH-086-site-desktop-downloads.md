---
id: VDH-086
title: Site: desktop app download section (per OS, from the latest release)
status: todo
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

- [ ] Section with links that resolve to the latest release's installers
- [ ] en/it, site checks green
- [ ] CI green on the PR head

## Notes

- Split from VDH-069.
