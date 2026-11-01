---
id: VDH-087
title: Desktop window: the shared components lost the styles only they use
status: in-progress
priority: P1
area: desktop
depends_on: [VDH-066]
---

# VDH-087: Desktop window: the shared components lost the styles only they use

## Description

In the desktop app the section tabs render as one run of text ("QUEUE0HISTORY0CONVERT0SETTINGS0", owner's screenshot):
Tailwind v4 only detects classes in files under the build's root, and the desktop window is built from `desktop/ui`, so
the classes only the shared components in `src/` use (the tabs, the queue items, badges…) were never generated.

## Acceptance criteria

- [ ] The shared theme declares `src/` as a source, so the desktop window's CSS carries every class the shared
      components use (checked against the built CSS)
- [ ] A test fails when a class used only by a shared component is missing from the desktop window's CSS
- [ ] The window looks right in the real app (screenshot through tauri-driver)
- [ ] CI green on the PR head
