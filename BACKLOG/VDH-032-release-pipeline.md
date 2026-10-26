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

- [x] `npm run package` builds a zip with `manifest.json` at its root and the right version in the file name
- [x] The zip contains the bundled FFmpeg core and loads unpacked in Chromium without manifest/CSP errors
- [x] Workflow verifies (typecheck, lint, format, unit tests, build, dist check) before packaging
- [ ] A release is created only once per version (tag `v<version>`), re-runs on the same version do not fail or overwrite it
- [x] Every release-worthy push to `main` gets the next version automatically (patch by default, `#minor` / `#major` in a commit message or a manual run input raise it); package.json can still force a higher version
- [x] The version computation is unit-tested (no tags, patch/minor/major, forced, package.json ahead, re-run on a tagged commit)
- [ ] A new version produces a new tag + release (verified on GitHub)
- [x] Workflow YAML valid; every `npm run` it uses exists

## Notes

Verified locally: `npm run package` in a clean clone after `npm ci` (same SHA-256 as the working copy: reproducible), zip integrity and checksum, and the unzipped package loaded in Chromium (popup, options, side panel, FFmpeg core reachable, no console errors). The once-per-version tag check was exercised in a shell with and without a tag.

Automatic bumping: `scripts/lib/version.ts` (19 tests, including a test that drives `scripts/next-version.mjs` through a real git history with tags, `#minor`, `#major`, re-runs and a package.json jump) and a simulated second release in a fresh clone (tag `v0.1.0` + one commit -> `0.1.1`, zip and manifest agree).

**Not verified:** the workflow itself has not run on GitHub, so `gh release create`, the `contents: write` permission and the artifact hand-off between the two jobs are untested. It also only runs for pushes to `main`, and `main` does not contain the project yet. Close this task after the first real release appears.
