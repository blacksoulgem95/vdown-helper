---
id: VDH-087
title: Desktop window: the shared components lost the styles only they use
status: done
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

- [x] The shared theme declares `src/` as a source, so the desktop window's CSS carries every class the shared
      components use (checked against the built CSS)
- [x] A test fails when a class used only by a shared component is missing from the desktop window's CSS
- [x] The window looks right in the real app (screenshot through tauri-driver)
- [x] CI green on the PR head

## Notes

- Fixed in PR #25 (merged as `2ab175a`). Verified with tauri-driver screenshots of the real app: Queue, Convert and
  Settings, with the tabs, counts, panels and forms styled.
- Removing `@source '..'` makes `scripts/build-desktop-ui.mjs` fail and name the 16 missing classes. With the fix, all
  23 of the Tabs component's classes are in the window's CSS.
- The window build runs in `app-e2e`, `link-e2e` and every installers job, so a release cannot ship the window
  without these styles.
- CI was 20/20 green on `5f8e576`, and the full local suite passed on the same head.
- The Settings tab no longer shows a count (`Tabs.count` is optional).
