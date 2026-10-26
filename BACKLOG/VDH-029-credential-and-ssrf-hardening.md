---
id: VDH-029
title: Cookies and extension fetches limited to what the user chose
status: done
priority: P0
area: security
depends_on: [VDH-008, VDH-011]
---

# VDH-029: Cookies and extension fetches limited to what the user chose

## Description

Independent review finding: with all-sites access granted, a hostile page could make the extension send cookie-bearing requests (from the extension origin, exempt from CORS) to any URL it named, including localhost and private ranges; downloads also marked every playlist origin as credentialed.

## Acceptance criteria

- [x] Cookies are only sent to the page's own origin (enforced in `sanitizeRequest`, the extension fetcher and the offscreen pipeline)
- [x] Extension-origin fetches refuse loopback/private/link-local/.local targets unless the page itself is on a private host
- [x] Automatic scans never fall back to extension-origin fetches
- [x] Access probes never target private hosts; poster images load only from the page's own host
- [x] Unit tests for the private-host classifier and for the credential filter

## Notes

Code: `isPrivateHost`/`mayExtensionFetch` in `src/lib/security.ts`, `src/background/pageFetch.ts`, `src/lib/request.ts`, `src/lib/uiActions.ts`. Not verified: behaviour with a real all-sites grant (needs Chrome's prompt, VDH-028). Known remaining limit: a page can still make the *page-origin* fetch (the scanner) request URLs it names, exactly as the page itself could.
