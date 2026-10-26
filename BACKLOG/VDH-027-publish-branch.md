---
id: VDH-027
title: Publish the branch to GitHub
status: done
priority: P0
area: build
depends_on: []
---

# VDH-027: Publish the branch to GitHub

## Description

Pushing `claude/confident-archimedes-8e7ebj` to `blacksoulgem95/vdown-helper` fails with HTTP 403: "Claude doesn't have GitHub access to blacksoulgem95/vdown-helper for your organization". Everything is committed locally.

## Acceptance criteria

- [x] Claude GitHub App installed / GitHub reconnected for the repository
- [x] `git push -u origin claude/confident-archimedes-8e7ebj` succeeds
- [ ] CI workflow runs (moved to VDH-022)

## Notes

Needs an org admin: install the Claude GitHub App (https://github.com/apps/claude/installations/select_target) or reconnect GitHub at https://claude.ai/connect-github. `add_repo` reported the repository as already attached, so this is an authorisation problem, not a missing clone.

Re-tried after the user asked again: `git push` still returns 403, and the GitHub API tools can read the repo (it is empty, no branches) but writes fail with "Resource not accessible by integration" (403). The fix is the same: grant the Claude GitHub App write access to `blacksoulgem95/vdown-helper`.

Resolved: after the app was installed on the repository's owner account, `git push` succeeded and created the branch. Seeing CI run is tracked in VDH-022; the push itself is complete.
