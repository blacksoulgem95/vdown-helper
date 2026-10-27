---
id: VDH-052
title: GitHub Pages site and Chrome Web Store images (en + it)
status: in-progress
priority: P1
area: docs
depends_on: [VDH-050, VDH-044]
---

# VDH-052: GitHub Pages site and Chrome Web Store images (en + it)

## Description

A landing page whose one job is getting the extension installed, published with GitHub Pages, and the Chrome Web Store images,
in English and Italian. Everything is generated from the real extension running on a labelled demo page with media made locally
(ffmpeg), so the images can be rebuilt after every UI change with one command.

Store image rules: up to 5 screenshots of 1280 x 800, a small promo tile of 440 x 280 and a marquee of 1400 x 560, all 24-bit
PNG/JPEG without alpha.

## Acceptance criteria

- [ ] `npm run store:assets` renders, per language, 5 screenshots (1280 x 800), the small tile (440 x 280) and the marquee
      (1400 x 560) from the real extension on a labelled demo page; every file is checked to be that size and 24-bit RGB with no alpha
- [ ] The site (`site/`) is built by `npm run site:build` from one template and an en/it string table (keys in sync, unit-tested),
      loads nothing from third parties, and works without JavaScript
- [ ] The primary button points at the Chrome Web Store once `site/config.json` has its URL; until then it says "coming soon" and
      offers the GitHub release with a 3-step install
- [ ] Copy follows `docs/store-policy.md`: no service names, no "all sites" promise, honest about DRM and the user's responsibility
- [ ] A Pages workflow deploys `site/` from `main`; site/store-only changes do not publish an extension release
- [ ] CI green on the PR head

## Notes

- GitHub Pages must be switched on once by the owner: Settings -> Pages -> Source: GitHub Actions.
- No testimonials, ratings or user counts: there are none yet, and inventing them is not allowed.
