---
id: VDH-043
title: Realistic test players and fixtures
status: in-progress
priority: P1
area: test
depends_on: [VDH-033]
---

# VDH-043: Realistic test players and fixtures

## Description

Dev-only hls.js and dash.js in local fixture pages, nested cross-origin iframes on 127.0.0.x origins, Referer-gated and ranged servers, mock open-site APIs. Never shipped in the extension.

## Acceptance criteria

- [ ] hls.js and dash.js produce genuine blob/MSE playback in fixtures
- [ ] Nested iframe fixtures on three origins
- [ ] Dev dependencies are not in dist (check-dist asserts it)

## Notes

_None yet._
