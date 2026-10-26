---
id: VDH-013
title: Design system and theme
status: done
priority: P1
area: ui
depends_on: [VDH-001]
---

# VDH-013: Design system and theme

## Description

Tailwind theme tokens from the spec palette (#080A12, #101522, #00F5FF, #FF2BD6, #B7FF3C, #F2F5FF, #8994AA, #FF4D6D), glass panels, thin borders, restrained scanline/grid, mono + sans fonts bundled locally, base components (Button, Badge, Card, ProgressBar, Toggle, Select, Icon wrapper), focus rings, `prefers-reduced-motion`.

## Acceptance criteria

- [x] Contrast >= WCAG AA for text on surfaces
- [x] No external font/CDN requests
- [x] Components keyboard accessible

## Notes

Contrast is asserted from the real tokens in `tests/contrast.test.ts` (all text colours ≥ 4.5:1 on all three surfaces). Disabled-control styling is exempt from contrast rules.
