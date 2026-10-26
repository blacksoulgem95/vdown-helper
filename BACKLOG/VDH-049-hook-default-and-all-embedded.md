---
id: VDH-049
title: Page hook on by default, one grant for all embedded players
status: in-progress
priority: P1
area: security
depends_on: [VDH-033]
---

# VDH-049: Page hook on by default, one grant for all embedded players

## Description

The owner wants _Look inside players_ on by default and embedded players allowed "always". Asking per origin and per nesting level missed
frames that navigate away from their `src` (the popup kept offering the old origin, and granting it changed nothing). Chrome never lets an
extension grant itself site access, so all-sites access stays optional and is asked for once, on the user's click; after that every frame
of every site is scanned without asking again.

## Acceptance criteria

- [ ] `pageHook` defaults to on; the hook is registered only for the sites the user allowed (unit + E2E)
- [ ] Existing installs get it switched on once by a migration on update; turning it off afterwards sticks; a new install only records the migration (unit; the install case also E2E)
- [ ] The popup's embedded-players button asks once for all sites (`<all_urls>` + header replay) and then offers a page reload when the hook is on (payload: unit; button: E2E)
- [ ] Settings: _Allow all sites and embedded players_ switch; the hook switch needs no prompt; _Revoke access_ keeps the hook setting
- [ ] en/it strings, README, `docs/store-policy.md`, `CLAUDE.md` updated
- [ ] CI green on the PR, PR merged

## Notes

- `<all_urls>` stays in `optional_host_permissions`: nothing new at install, and existing installs are not disabled by the update.
- Not automatable: Chrome's permission prompt itself and a real update from an older version (the migration is unit-tested) -> VDH-028.
- DRM refusal, header replay limits and the http/https-only rule are unchanged. Nothing site-specific; nothing clicks through link
  protectors or captchas.
