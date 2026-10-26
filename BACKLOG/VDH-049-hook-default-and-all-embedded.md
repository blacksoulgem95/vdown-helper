---
id: VDH-049
title: Page hook on by default, one grant for all embedded players
status: done
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

- [x] `pageHook` defaults to on; the hook is registered only for the sites the user allowed (unit + E2E)
- [x] Existing installs get it switched on once by a migration on update; turning it off afterwards sticks; a new install only records the migration (unit; the install case also E2E)
- [x] The popup's embedded-players button asks once for all sites (`<all_urls>` + header replay) (payload: unit; button: E2E). The reload offer after a real grant needs Chrome's prompt -> VDH-028
- [x] Settings: the hook switch only stores the setting (no prompt) and _Revoke access_ keeps it (typecheck; the stored setting drives registration: E2E). The new _Allow all sites and embedded players_ switch needs Chrome's prompt -> VDH-028
- [x] en/it strings, README, `docs/store-policy.md`, `CLAUDE.md` updated
- [x] CI green on the PR head (run 40322827859 on `25c3550`: `check` and `e2e`; `main` run 40323962531 green) and merged as `087e584`; Release run 40323962533 published `v1.1.1` (patch: the merge message carried no bump token)

## Notes

- Verified: 615 unit tests; full local E2E 108/108 (a fresh install records the migration and registers the hook for the allowed
  test origins, off removes it, the blocked-frames notice shows `ALLOW ALL EMBEDDED PLAYERS`).
- `<all_urls>` stays in `optional_host_permissions`: nothing new at install, and existing installs are not disabled by the update.
- Found on CI (run 40321369144): with the hook on by default, two overlapping `syncHook()` calls could finish out of order and
  leave the hook registered after it was turned off ("timed out waiting for hook removal"). Calls now run one after another;
  `tests/hook-sync.test.ts` reproduces the race (fails without the fix).
- Not automatable: Chrome's permission prompt itself and a real update from an older version (the migration is unit-tested) -> VDH-028.
- DRM refusal, header replay limits and the http/https-only rule are unchanged. Nothing site-specific; nothing clicks through link
  protectors or captchas.
