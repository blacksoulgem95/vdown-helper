---
id: VDH-051
title: MediaSource players say what is missing and offer the one fix
status: in-progress
priority: P1
area: ui
depends_on: [VDH-049]
---

# VDH-051: MediaSource players say what is missing and offer the one fix

## Description

Reported on a real embed page: a MediaSource player was listed with its internal label as the title (`x-vdh-mse;vdh=…`), the
source "embedded in the page (data:)", and the advice to turn on "Look inside players", which is already on by default since 1.1.1.
What was actually missing: the site was not allowed, so the hook was never registered there.

## Acceptance criteria

- [ ] The card names what is missing: the setting is off, the site is not allowed, or the player started before the hook (unit; the reload case also E2E)
- [ ] One button fixes it: `ALLOW & RELOAD` (asks for the player's site, switches the hook on if needed, waits until the hook is registered, reloads) or `RELOAD PAGE` (E2E for the reload case)
- [ ] The card shows the page title and "a player in the page (Media Source)", never the internal label (unit + E2E)
- [ ] CI green on the PR head

## Notes

- Generic: nothing here knows about any site. DRM/EME players are still refused by the hook's report; nothing bypasses a site's own
  checks.
- The "site not allowed" case needs a real permission prompt -> VDH-028.
