---
id: VDH-010
title: Direct file downloads via chrome.downloads
status: done
priority: P0
area: background
depends_on: [VDH-009]
---

# VDH-010: Direct file downloads via chrome.downloads

## Description

Native downloads for MP4/WebM etc. Map `chrome.downloads` events to bytes/total/speed/ETA, support pause/resume where `canResume`, cancel, retry, open file, show in folder, subfolder + filename from sanitised template, `conflictAction: uniquify`.

## Acceptance criteria

- [x] Real byte progress; unknown totals shown as unknown
- [x] Pause/resume only offered when supported
- [x] Failed downloads surface Chrome's error reason
- [x] Verified in real Chromium (VDH-018)

## Notes

Real Chrome downloads in E2E: completion, byte progress, pause/resume, failure reason (`SERVER_BAD_CONTENT`), unicode-name fallback (unit-tested). Open / Show use the page-side gesture path (VDH-025).
