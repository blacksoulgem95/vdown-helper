---
id: VDH-051
title: MediaSource players say what is missing and offer the one fix
status: done
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

- [x] The card names what is missing: the setting is off, the site is not allowed, or the player started before the hook (unit; the reload case also E2E)
- [x] One button fixes it: `ALLOW & RELOAD` (asks for the player's site, switches the hook on if needed, waits until the hook is registered, reloads) or `RELOAD PAGE` (E2E for the reload case)
- [x] The card shows the page title and "a player in the page (Media Source)", never the internal label (unit + E2E)
- [x] CI green on the PR head

## Notes

- Verified: unit tests (`tests/mse-reasons.test.ts`), local E2E 111/111 on `a586278` (incl. the reload case), CI run 40328166372 on the PR head and 40328676601 on `main`; merged as `a41adfd`, released as `v1.1.2`.

- Generic: nothing here knows about any site. DRM/EME players are still refused by the hook's report; nothing bypasses a site's own
  checks.
- The "site not allowed" case needs a real permission prompt -> VDH-028.
