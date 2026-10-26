---
id: VDH-022
title: CI workflow and lint/format tooling
status: in-progress
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

- [ ] Workflow has run successfully on GitHub (branch is pushed; the first run has not been observed yet)

## Notes

Workflow YAML parses and every `npm run` it uses exists. The branch is now pushed (VDH-027), but no run has been observed yet: check the Actions tab. Note the workflow triggers on `push`, so it should start on its own.
