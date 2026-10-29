---
id: VDH-075
title: Desktop engine: persistent queue, resume after restart, bandwidth cap, schedule, history
status: todo
priority: P1
area: desktop
depends_on: [VDH-065]
---

# VDH-075: Desktop engine: persistent queue

## Description

The download manager around the engine's jobs (VDH-065): a queue kept in SQLite that survives the app being closed or
killed, pause / resume / retry, a global bandwidth cap, a schedule window and a history of finished jobs with redacted
URLs. Split out of VDH-065.

## Acceptance criteria

- [ ] SQLite queue (jobs, their stages and progress, segments written): 3 jobs at a time, 4 segments each by default
- [ ] Pause / resume / retry / cancel; a job resumes after `kill -9` and the result is identical to an uninterrupted run
- [ ] Global bandwidth cap (token bucket) and a schedule window that pauses and resumes jobs
- [ ] History until cleared (can be turned off), URLs stored with credentials and tokens stripped; cookies never stored
- [ ] `vdh` CLI commands for the queue, used by integration tests against the fixture servers
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
