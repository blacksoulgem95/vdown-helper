---
id: VDH-022
title: CI workflow and lint/format tooling
status: todo
priority: P2
area: build
depends_on: [VDH-001]
---

# VDH-022: CI workflow and lint/format tooling

## Description

GitHub Actions: typecheck, lint, unit tests, build with zipped `dist` artifact; separate Playwright E2E job. Prettier + ESLint configs.

## Acceptance criteria

- [ ] Workflow YAML valid
- [ ] Jobs reference only npm scripts that exist
- [ ] `dist` zip uploaded as artifact

## Notes

_None yet._
