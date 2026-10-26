---
id: VDH-027
title: Publish the branch to GitHub
status: blocked
priority: P0
area: build
depends_on: []
---

# VDH-027: Publish the branch to GitHub

## Description

Pushing `claude/confident-archimedes-8e7ebj` to `blacksoulgem95/vdown-helper` fails with HTTP 403: "Claude doesn't have GitHub access to blacksoulgem95/vdown-helper for your organization". Everything is committed locally.

## Acceptance criteria

- [ ] Claude GitHub App installed / GitHub reconnected for the repository
- [ ] `git push -u origin claude/confident-archimedes-8e7ebj` succeeds
- [ ] CI workflow runs (VDH-022)

## Notes

Needs an org admin: install the Claude GitHub App (https://github.com/apps/claude/installations/select_target) or reconnect GitHub at https://claude.ai/connect-github. `add_repo` reported the repository as already attached, so this is an authorisation problem, not a missing clone.
