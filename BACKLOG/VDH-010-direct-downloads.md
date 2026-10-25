---
id: VDH-010
title: Direct file downloads via chrome.downloads
status: in-progress
priority: P0
area: background
depends_on: [VDH-009]
---

# VDH-010: Direct file downloads via chrome.downloads

## Description

Native downloads for MP4/WebM etc. Map `chrome.downloads` events to bytes/total/speed/ETA, support pause/resume where `canResume`, cancel, retry, open file, show in folder, subfolder + filename from sanitised template, `conflictAction: uniquify`.

## Acceptance criteria

- [ ] Real byte progress; unknown totals shown as unknown
- [ ] Pause/resume only offered when supported
- [ ] Failed downloads surface Chrome's error reason
- [ ] Verified in real Chromium (VDH-018)

## Notes

Implemented in `src/background/runner.ts` (runNative, polling, pause/resume/open/show). Needs E2E verification.
