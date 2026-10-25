---
id: VDH-001
title: Project scaffold
status: in-progress
priority: P0
area: build
depends_on: []
---

# VDH-001: Project scaffold

## Description

Set up Vite multi-entry build (pages as ES modules, service worker, content script as separate IIFE), TypeScript strict, React 19, Tailwind 4, Lucide, Vitest + jsdom, ESLint, Prettier, `scripts/build.mjs`, and npm scripts.

## Acceptance criteria

- [ ] `npm run build` produces a loadable `dist/`
- [ ] `npm run typecheck`, `lint`, `test` all run (even if few tests yet)
- [ ] Strict TS flags enabled (`strict`, `noUncheckedIndexedAccess`)
- [ ] `CLAUDE.md` Commands section updated

## Notes

_None yet._
