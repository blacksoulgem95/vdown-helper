---
id: VDH-033
title: All-frame scanning, opt-in page hook, header replay
status: done
priority: P0
area: content
depends_on: [VDH-008]
---

# VDH-033: All-frame scanning, opt-in page hook, header replay

## Description

Scan every frame (nested and cross-origin iframes), record the frame each candidate came from, and add the opt-in all-sites page hook (MAIN world, document_start) that logs fetch/XHR manifest and segment URLs and sees MSE/EME activity. Downloads replay only the Referer/Origin the browser itself sent for the owning frame (declarativeNetRequest session rules, per job).

## Acceptance criteria

- [x] Candidates from nested cross-origin iframes are detected when access is granted; otherwise the popup lists the frame origins and offers a per-origin "Allow embedded players" (the button is verified present; Chrome's permission prompt itself cannot be automated, see VDH-028)
- [x] Hook is registered only while the optional permission is granted and removed when it is revoked
- [x] fetch/XHR discovery finds manifests a player loads from script
- [x] Referer/Origin replay makes a Referer-gated fixture download work, and is removed when the job ends
- [x] Hook messages are validated; a hostile page cannot inject anything but low-trust candidates
- [x] E2E: top -> iframe (origin B) -> nested iframe (origin C)

## Notes

Done and verified in real Chromium (E2E, 49 steps): A -> C -> D nested frames each report their own resources with frame id and URL; the opt-in hook (MAIN world, document_start) is registered only for the granted origins, only while enabled, and finds a manifest that the page wiped from resource timing (control: invisible without the hook); a page requesting Widevine marks that frame's media protected (`eme`), ClearKey does not; frames the extension cannot enter are listed with an allow button.

Header replay: DNR session rules set Referer/Origin to the owning frame for one job's own hosts and are removed afterwards. **Finding:** Chrome's native download manager does not receive them (server saw no Referer), so a native download refused with 401/403 is retried once through the extension's own fetch pipeline (`restage`, unit-tested); the E2E gated download completes that way and a no-frame control still fails.

Not verified: the real permission prompts (Options toggle, per-origin "Allow embedded players"), which automation cannot answer; the E2E build pre-grants access to the three test origins. Moved to VDH-028.
Security: cookies only go to the page origin and the owning frame's origin; the fallback probe never targets private hosts for a public page.
