---
id: VDH-002
title: MV3 manifest, permissions model, CSP
status: todo
priority: P0
area: build
depends_on: [VDH-001]
---

# VDH-002: MV3 manifest, permissions model, CSP

## Description

Author `manifest.json`: `activeTab, scripting, downloads, storage, offscreen, notifications, sidePanel`; optional `webRequest` + `<all_urls>`; CSP `script-src 'self' 'wasm-unsafe-eval'`; `default_locale`; icons; action popup; options page; side panel.

## Acceptance criteria

- [ ] Manifest validated by a script (required keys, referenced files exist in `dist/`)
- [ ] No broad host permission is granted at install time
- [ ] Each permission is justified in README (VDH-019)

## Notes

_None yet._
