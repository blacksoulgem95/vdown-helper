---
id: VDH-032
title: Release pipeline for main (Chrome package + tag + GitHub Release)
status: in-progress
priority: P1
area: build
depends_on: [VDH-022, VDH-002]
---

# VDH-032: Release pipeline for main (Chrome package + tag + GitHub Release)

## Description

A GitHub Actions workflow that runs on `main`: verifies the project, builds the extension, packages `dist/` as a Chrome-ready zip (manifest.json at the zip root) and, when the version in `package.json` has not been released yet, creates the tag `v<version>` and a GitHub Release with the zip and a checksum attached. A `scripts/package.mjs` produces the same zip locally (`npm run package`).

## Acceptance criteria

- [ ] `npm run package` builds a zip with `manifest.json` at its root and the right version in the file name
- [ ] The zip contains the bundled FFmpeg core and loads unpacked in Chromium without manifest/CSP errors
- [ ] Workflow verifies (typecheck, lint, format, unit tests, build, dist check) before packaging
- [ ] A release is created only once per version (tag `v<version>`), re-runs on the same version do not fail or overwrite it
- [ ] A new `package.json` version produces a new tag + release (verified on GitHub)
- [ ] Workflow YAML valid; every `npm run` it uses exists

## Notes

_None yet._
