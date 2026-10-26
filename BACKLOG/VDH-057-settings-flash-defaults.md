---
id: VDH-057
title: Settings page showed the defaults until the stored settings loaded
status: in-progress
priority: P2
area: ui
depends_on: [VDH-010]
---

# VDH-057: Settings page showed the defaults until the stored settings loaded

## Description

CI on PR #8 (run 40336797408) failed "settings persist across reloads": right after a reload the select still said the default
mode although storage held `audio-only`. `useSettings` starts from `DEFAULT_SETTINGS`; Options rendered every field at once, so
for a moment it showed (and let the user edit) values that were not theirs. Locally the read usually won the race.

## Acceptance criteria

- [ ] No field is shown until the stored settings are read; then the stored values (unit: the read held open shows 0 fields, 5 before the fix)
- [ ] E2E "settings persist across reloads" passes without being weakened
- [ ] CI green on the PR head

## Notes

- The Studio and the subtitle form already wait for `loaded`. The popup reads settings only when a button is pressed, by which time
  the scan (much slower than a storage read) has finished.
