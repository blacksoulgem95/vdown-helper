---
id: VDH-022
title: CI workflow and lint/format tooling
status: done
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

- [x] Workflow has run successfully on GitHub (both jobs green in CI runs 15, 17, 19, 21, 22 and 23 on this branch)

## Notes

The workflow runs on every push and pull request. Both jobs have passed on GitHub several times. The e2e job has also failed in some runs because of
a product bug in how the final segment counters are reported; that is tracked and fixed in VDH-048.
