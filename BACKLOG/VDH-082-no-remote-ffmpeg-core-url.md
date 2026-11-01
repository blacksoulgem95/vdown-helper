---
id: VDH-082
title: Web Store "remotely hosted code": FFmpeg.wasm's unpkg fallback in the bundled worker
status: in-progress
priority: P0
area: build
depends_on: []
---

# VDH-082: Web Store "remotely hosted code": FFmpeg.wasm's unpkg fallback in the bundled worker

## Description

The Chrome Web Store rejected an upload for "Inclusion of remotely hosted code in a Manifest V3 item". The built
FFmpeg.wasm worker (`dist/assets/worker-*.js`, from `@ffmpeg/ffmpeg`) carries the library's default core address
`https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd/ffmpeg-core.js` and passes it to `importScripts()` / `import()` when no
`coreURL` is given. The extension always passes the bundled core (`vendor/ffmpeg/`), and the CSP would block a remote
script anyway, but the address must not ship at all. `check:dist` did not see it: its remote-import check only matched
a URL written inside the call, and it skipped `vendor/`.

## Acceptance criteria

- [ ] The build replaces the library's default core address with the bundled copy, and fails if the library changes
      so that the replacement no longer applies
- [ ] `check:dist` scans every shipped script (`vendor/` included) and fails on any http(s) address except a short
      allowlist of inert strings (XML namespaces, documentation links in error messages)
- [ ] FFmpeg.wasm still works: the extension E2E (merges, conversions) passes
- [ ] CI green on the PR head

## Notes

- Found on `main` at `bb6d6f5`, after the owner reported the rejection of an older upload.
