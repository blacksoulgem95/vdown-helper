---
id: VDH-053
title: Network observer missed requests (sleeping worker, lost writes)
status: in-progress
priority: P0
area: background
depends_on: [VDH-012]
---

# VDH-053: Network observer missed requests (sleeping worker, lost writes)

## Description

Reported: with "Observe media requests" on, a player's HLS master (`…/hls/<ids>,.urlset/master.m3u8` on a CDN) was not listed.
Two generic causes:

1. The webRequest listener was added only after reading the settings (an `await`), so Chrome did not wake the sleeping service
   worker for it: whatever the page loaded while the worker slept was never seen.
2. Each observed request did an unordered read-modify-write of the tab's list; a player asks for its master and variants in the
   same moment, and the writes overwrote each other (the master was often the one lost).

## Acceptance criteria

- [ ] The listener is registered synchronously at worker start when the permission is held; a request that arrives before the
      settings are read is kept if the observer is on (unit)
- [ ] A burst of requests is recorded in full (unit; reproduced first: 1 of 5 kept before the fix)
- [ ] The `webRequest` permission is dropped when the observer is switched off (or all-sites access is), so a sleeping worker is
      never woken for nothing
- [ ] Existing E2E observer step still passes; CI green on the PR head

## Notes

- The listener only exists while the user has the observer on: it needs the optional `webRequest` permission, which Settings asks
  for when the observer is switched on and now removes when it is switched off.
