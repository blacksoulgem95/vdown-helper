---
id: VDH-009
title: Download queue and state machine
status: todo
priority: P0
area: background
depends_on: [VDH-003]
---

# VDH-009: Download queue and state machine

## Description

Persisted queue in `chrome.storage.local`. Stages: DETECTED, PREPARING, DOWNLOADING, MERGING, ENCODING, COMPLETED, FAILED, CANCELLED. Validated transitions, max concurrency, cancel, retry, history, clear history. Progress only from real signals.

## Acceptance criteria

- [ ] Illegal transitions rejected
- [ ] Queue rehydrates after worker restart; interrupted jobs marked FAILED with reason
- [ ] Concurrency limit honoured
- [ ] Unit tests for transitions, failure, cancel, retry

## Notes

_None yet._
