---
id: VDH-058
title: A loading frame wiped the page's results; a frame that never finishes loading hung the scan
status: done
priority: P0
area: background
depends_on: [VDH-033]
---

# VDH-058: A loading frame wiped the page's results; a frame that never finishes loading hung the scan

## Description

Reported: when an iframe loads, the extension "crashes", scans forever and deletes everything found on the page.

1. `tabs.onUpdated` with `status: 'loading'` was treated as a new page, but Chrome also reports it while a frame loads (a player
   appearing after a click). That cleared the tab's results, the requests the network observer had seen and the links the user
   had added.
2. `scripting.executeScript` waits, by default, until every frame has finished loading. One frame that never finishes (a player
   streaming over a kept-open connection, a stalled ad) held the scan forever, and every later rescan joined the stuck one.

## Acceptance criteria

- [x] Only a change of the top document's address (ignoring `#fragment`) clears the tab (unit: `sameDocument`)
- [x] Every injection runs immediately (no wait for frames to load); scanning all frames, reading the hook and calls into a frame
      have deadlines, with a top-frame-only fallback (unit: `withDeadline`)
- [x] A scan has an overall deadline, after which it ends as an error that keeps what the tab showed; a late or superseded scan
      never overwrites newer results (generation per tab)
- [x] E2E: a frame added after load keeps the page's results; with a frame that never finishes loading the scan ends (0.2 s) and
      lists both the page's and the late player frame's media (reproduced first: no READY after 40 s)
- [x] CI green on the PR head

- Verified: local suite (E2E 113/113) on a9d64c1; CI on PR #10 green: CI runs 40622400239 and 40622404968 (check, e2e), Desktop runs 40622400375 and 40622405037 (rust on Linux, Windows, macOS).
