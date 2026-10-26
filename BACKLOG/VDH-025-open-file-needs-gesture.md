---
id: VDH-025
title: Open / show downloaded file needs a user gesture
status: done
priority: P1
area: ui
depends_on: [VDH-014]
---

# VDH-025: Open / show downloaded file needs a user gesture

## Description

Found during E2E: `chrome.downloads.open()` answered "User gesture required" when called from the service worker, so the Open file button could never work. The call now runs in the popup / side panel that received the click; the background no longer accepts `open`/`show`.

## Acceptance criteria

- [x] Open and Show are performed by the page that received the click
- [x] The background rejects `open`/`show` messages
- [x] A missing file produces a clear message instead of a silent failure
- [x] E2E clicks both buttons

## Notes

Regression guard: `tests/messaging.test.ts` (rejects `open`) and the E2E step "open file / show in folder: real clicks".
