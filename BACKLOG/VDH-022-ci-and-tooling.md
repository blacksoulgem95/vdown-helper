---
id: VDH-022
title: CI workflow and lint/format tooling
status: blocked
priority: P2
area: build
depends_on: [VDH-001]
---

# VDH-022: CI workflow and lint/format tooling

## Description

GitHub Actions: typecheck, lint, unit tests, build with zipped `dist` artifact; separate Playwright E2E job. Prettier + ESLint configs.

## Acceptance criteria

- [x] Workflow YAML valid
- [x] Jobs reference only npm scripts that exist
- [x] `dist` zip upload step defined

- [ ] Workflow has run successfully on GitHub (blocked: the branch cannot be pushed, see VDH-027)

## Notes

Workflow YAML parses and every `npm run` it uses exists. **Blocked:** it has never executed on GitHub because the branch could not be pushed (VDH-027).
