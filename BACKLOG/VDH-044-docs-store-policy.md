---
id: VDH-044
title: Docs, store policy and constraints update
status: in-progress
priority: P1
area: docs
depends_on: [VDH-043]
---

# VDH-044: Docs, store policy and constraints update

## Description

Update README (supported/unsupported tables, limits), CLAUDE.md constraints (blob/data handling, DRM wording, opt-in hook), THIRD_PARTY_NOTICES, add docs/store-policy.md (permission disclosures, Web Store risk) and extend the manual test procedure.

## Acceptance criteria

- [x] README tables match what was verified (every row of "Implemented vs unsupported" is backed by a unit or E2E test named in the task that delivered it; what is not verified is listed in the right-hand column and in "What the automated run does not prove")
- [x] CLAUDE.md constraints updated (DRM wording, `blob:`/`data:` handled only inside the owning page, opt-in hook, request re-derivation, noncharacter gotcha, dev-only tools)
- [x] Store policy document written with the honest risk assessment (`docs/store-policy.md`; the store's current policy text could not be read from the build environment)
- [x] VDH-028 includes the new manual scenarios

## Notes

- README: rewritten usage, the supported/unsupported table, output modes, permissions (optional: site access, `declarativeNetRequestWithHostAccess`, `webRequest`, all-sites page hook), limitations, architecture,
  the test description (what is and is not proven), the manual procedure (steps 11-16 are new) and troubleshooting. `THIRD_PARTY_NOTICES.md` lists the development-only players and tools.
- The fixture server (`npm run serve:fixtures`) prints the URLs of the new pages for the manual procedure.
