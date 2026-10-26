---
id: VDH-047
title: Fixes from the independent security review
status: done
priority: P0
area: security
depends_on: [VDH-044]
---

# VDH-047: Fixes from the independent security review

## Description

An independent adversarial review (a fresh reviewer given the code, the trust boundaries and the project rules, but not our conclusions) found no remote exfiltration, no
page-reachable privileged channel and no DRM or cookie-scope bypass, but several denial-of-service and hardening problems. Each is fixed with a test that reproduces it.

## Acceptance criteria

- [x] M1: a trailing-comment XML document no longer takes quadratic time (reproduced at 150 000 repeats: now linear; `tests/xml.test.ts`)
- [x] M2: DASH templates cannot build huge URLs (printf width clamped to 20, `MAX_URL_LENGTH` 8192 in `isSafeFetchUrl` and the resolvers, template length cap, 8 M characters of addresses per representation; `tests/dash.test.ts`)
- [x] M3: HLS playlists cannot amplify memory through long base URLs; segment count capped at parse time (20 000; `tests/hls-parser.test.ts`)
- [x] L1: private-network hosts named by manifests are refused for the job's own requests too (`NetContext.allowed` in `offscreen/hls.ts`, every playlist, key, init, segment, ZIP item and subtitle fetch; a page on a private host may still use private addresses). Name-based only: a public name that resolves to a private address is not caught (a limit of extension fetches)
- [x] L2: cookies go to a granted origin only when the manifest that names the URL is itself on a granted origin (`tests/net-context.test.ts`)
- [x] L3: live recording has a wall-clock limit and gives up (60 s) on a stream that yields no new bytes; limits are checked before every fetch and after every write (`shouldStop`), so the byte limit no longer overshoots by a batch
- [x] L4: privileged messages and offscreen events must come from extension pages (`isExtensionPage`); the blob URL of a `ready` event must be this extension's (`isOwnBlobUrl`)
- [x] L5 (partly): a request for a resource the scan found protected (e.g. by the EME hook) is refused whatever it says. Not done, on purpose: requiring every field of a request to equal the scanned resource's. The senders are now only extension pages (L4), several flows legitimately name variant or audio addresses, and the manifest-derived facts (DRM, live, size) are already re-derived from the manifest itself
- [x] L6: the extension of a plain file is forced into the set of its kind (`tests/files-analyze.test.ts`)
- [x] L7: no remote thumbnails in the popup / Studio (no beacon to the page's host); file and video cards use icons
- [x] L8: `check:dist` rejects unexpected manifest keys and permissions (allow-list; seen to fire); no bare console in content scripts. Left as is: the on-page banner lives in the page's DOM, so a page can hide it with CSS; it is a notice, not an enforcement (documented)

## Notes

Review findings were reproduced before fixing; see the commit for the tests.
