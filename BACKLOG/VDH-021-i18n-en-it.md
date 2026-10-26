---
id: VDH-021
title: Internationalisation (en, it)
status: done
priority: P1
area: ui
depends_on: [VDH-003]
---

# VDH-021: Internationalisation (en, it)

## Description

Use `_locales/en` and `_locales/it` with `chrome.i18n`, a typed `t()` helper, and a test that both catalogs have identical keys.

## Acceptance criteria

- [x] No hard-coded UI strings in components
- [x] Catalog parity test passes
- [x] Italian reviewed for terminology consistency

## Notes

Catalog parity and placeholder parity are tested; the Italian UI is verified in a real browser started with an Italian UI language (strings and `$n` substitutions). Terminology reviewed by the author only; a native-speaker review would still be welcome.
