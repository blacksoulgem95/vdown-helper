---
id: VDH-075
title: Desktop engine: persistent queue, resume after restart, bandwidth cap, schedule, history
status: in-progress
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

- [x] SQLite queue (jobs, their stages and progress, segments written): 3 jobs at a time, 4 segments each by default
- [x] Pause / resume / retry / cancel; a job resumes after `kill -9` and the result is identical to an uninterrupted run
- [x] Global bandwidth cap (token bucket) and a schedule window that pauses and resumes jobs
- [x] History until cleared (can be turned off), URLs stored with credentials and tokens stripped; cookies never stored
- [x] `vdh` CLI commands for the queue, used by integration tests against the fixture servers
- [ ] CI green on the PR head

## Notes

- Plan agreed with the owner: see `docs/desktop.md`.
- Jobs are stored in the extension's `DownloadJob` shape and moved by `vdh-core`'s state machine (`create_job`,
  `transition`, `with_progress`, `retry_job`, `fail_job`), so stages mean the same on both sides.
- Resume: every staged track keeps a checkpoint (segments written, bytes, the initialisation section written) after each
  segment. After a restart the staging file is cut back to the checkpoint and the rest is fetched; plain files continue
  with a byte range. A live recording cannot get back the time it missed: what it had recorded is joined and kept.
- Requests (pause, resume, retry, cancel, stop, remove) are written to the database and applied by the running queue
  every 250 ms, so `vdh queue pause <id>` from another terminal (and later the app's window) reaches it.
- A finished job leaves the queue and stays in the history with `redact_url`'s address; failed and cancelled jobs stay in
  the queue (retry needs their request) and are also written to the history. Cookies are never stored: a job that needs
  them will ask the browser again (VDH-067).
- The schedule window is local time (`chrono`); outside it, running jobs go back to the queue with what they staged.
- `rusqlite` 0.40 with SQLite compiled in (0.41 needs Rust 1.89; the workspace declares 1.85).
