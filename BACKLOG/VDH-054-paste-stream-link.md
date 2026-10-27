---
id: VDH-054
title: Add a stream link by hand (.m3u8, .m3u, .mpd, media files)
status: in-progress
priority: P1
area: ui
depends_on: [VDH-050]
---

# VDH-054: Add a stream link by hand (.m3u8, .m3u, .mpd, media files)

## Description

Requested: paste a link (for instance an `.m3u8` seen in the browser's network panel) and have the extension treat it like
anything found on the page.

## Acceptance criteria

- [ ] A link button on the popup's page row opens a field; ADD remembers the link for that tab and rescans (E2E)
- [ ] Only http/https links are accepted; anything else is refused with an explanation (unit + E2E)
- [ ] The pasted link gets a normal card (probed, ranked, downloadable or explained) and survives rescans; it is forgotten when the
      tab navigates (E2E)
- [ ] At most 20 links per tab, deduplicated (unit)
- [ ] CI green on the PR head

## Notes

- Nothing special is granted to a pasted link: cookies only for allowed sites, the private-network guard, and a host that refuses
  cross-origin reads shows the usual "allow site access" button.
