---
id: VDH-001
title: Project scaffold
status: done
priority: P0
area: build
depends_on: []
---

# VDH-001: Project scaffold

## Description

Set up Vite multi-entry build (pages as ES modules, service worker, content script as separate IIFE), TypeScript strict, React 19, Tailwind 4, Lucide, Vitest + jsdom, ESLint, Prettier, `scripts/build.mjs`, and npm scripts.

## Acceptance criteria

- [x] `npm run build` produces a loadable `dist/`
- [x] `npm run typecheck`, `lint`, `test` all run (even if few tests yet)
- [x] Strict TS flags enabled (`strict`, `noUncheckedIndexedAccess`)
- [x] `CLAUDE.md` Commands section updated

## Notes

`npm run build|typecheck|lint|test|test:e2e|check:dist|serve:fixtures` all exist and pass locally (typecheck, eslint, prettier, 230+ unit tests, 41 E2E steps).
