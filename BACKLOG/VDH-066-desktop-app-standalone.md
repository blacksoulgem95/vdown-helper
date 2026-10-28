---
id: VDH-066
title: Desktop app (Tauri v2): standalone downloads, queue, history, tray
status: todo
priority: P1
area: desktop
depends_on: [VDH-065]
---

# VDH-066: Desktop app (Tauri v2): standalone downloads, queue, history, tray

## Description

The window: paste a media/playlist URL, scan a page's HTML (generic, no extractors, no scripts), drop local files, optional
clipboard watch (off by default). Reuses the extension's React components, theme, fonts and en/it catalogs.

## Acceptance criteria

- [ ] Paste URL -> qualities/DRM shown -> download; page scan; local file remux
- [ ] Queue, history (until cleared, can be turned off), folder rules (`{type}/{host}/{title}`), settings
- [ ] Tray with close-to-tray, start at login (opt-in), OS notifications, English and Italian
- [ ] Linux E2E of the real app with tauri-driver
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
