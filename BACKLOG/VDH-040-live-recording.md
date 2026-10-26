---
id: VDH-040
title: Live and event stream recording
status: todo
priority: P1
area: background
depends_on: [VDH-034]
---

# VDH-040: Live and event stream recording

## Description

Record HLS live/event and DASH dynamic streams by refreshing the manifest and appending new segments until Stop, stream end or a limit (default 2 h / 4 GB). New "recording" stage and "stop" action; output TS, or MP4 within the memory limit.

## Acceptance criteria

- [ ] Live HLS recording in E2E stops with Stop and with the limit, output decodable
- [ ] DASH dynamic recording works
- [ ] Duplicate/missed segments are handled by sequence
- [ ] Stop saves the file (is not cancel); cancel still discards
- [ ] Limits are configurable in Settings

## Notes

_None yet._
