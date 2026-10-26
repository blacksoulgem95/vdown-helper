---
id: VDH-037
title: Images, documents, archives and page assets with ZIP download
status: todo
priority: P1
area: ui
depends_on: [VDH-033]
---

# VDH-037: Images, documents, archives and page assets with ZIP download

## Description

Detect images (img, picture, CSS backgrounds, og:image), documents, archives and page assets; show them in their own tabs with counts, size filters and per-type caps; download one, selected, or all as ZIP (bounded by the memory limit).

## Acceptance criteria

- [ ] Each type has its own tab with a count and caps
- [ ] Image minimum-size filter works
- [ ] ZIP contains the selected files with collision-free names; above the limit it splits or refuses with an explanation
- [ ] E2E: image, PDF, archive and asset downloads, plus a ZIP

## Notes

_None yet._
