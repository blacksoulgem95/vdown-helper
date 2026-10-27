---
id: VDH-054
title: Add a stream link by hand (.m3u8, .m3u, .mpd, media files)
status: done
priority: P1
area: ui
depends_on: [VDH-050]
---

# VDH-054: Add a stream link by hand (.m3u8, .m3u, .mpd, media files)

## Description

Requested: paste a link (for instance an `.m3u8` seen in the browser's network panel) and have the extension treat it like
anything found on the page.

## Acceptance criteria

- [x] A link button on the popup's page row opens a field; ADD remembers the link for that tab and rescans (E2E)
- [x] Only http/https links are accepted; anything else is refused with an explanation (unit + E2E)
- [x] The pasted link gets a normal card (probed, ranked, downloadable or explained) and survives rescans; it is forgotten when the
      tab navigates (E2E)
- [x] At most 20 links per tab, deduplicated (unit)
- [x] CI green on the PR head

## Notes

- PR #8 merged as `2507446` after CI (`check`, `e2e`) green on `8c8d283` (runs 40340268758, 40340258255) and the full local suite (E2E 112/112); `main` CI run 40430131398 green; Release run 40430131437 published `v1.2.0`.

- Nothing special is granted to a pasted link: cookies only for allowed sites, the private-network guard, and a host that refuses
  cross-origin reads shows the usual "allow site access" button.
