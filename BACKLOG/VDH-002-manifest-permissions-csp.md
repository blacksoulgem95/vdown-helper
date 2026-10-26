---
id: VDH-002
title: MV3 manifest, permissions model, CSP
status: done
priority: P0
area: build
depends_on: [VDH-001]
---

# VDH-002: MV3 manifest, permissions model, CSP

## Description

Author `manifest.json`: `activeTab, scripting, downloads, storage, offscreen, notifications, sidePanel`; optional `webRequest` + `<all_urls>`; CSP `script-src 'self' 'wasm-unsafe-eval'`; `default_locale`; icons; action popup; options page; side panel.

## Acceptance criteria

- [x] Manifest validated by a script (required keys, referenced files exist in `dist/`)
- [x] No broad host permission is granted at install time
- [x] Each permission is justified in README (VDH-019)

## Notes

`scripts/check-dist.mjs` validates the built manifest, assets, locales, CSP and absence of remote code / install-time host access. Permissions are justified in README.
