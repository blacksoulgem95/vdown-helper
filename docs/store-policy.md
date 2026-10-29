# Chrome Web Store policy notes

This document is for whoever submits vdown-helper to the Chrome Web Store (or explains it to a reviewer or a user). It
gives the single purpose, a justification for every permission, the data-handling statement, and an **honest risk
assessment**. It is not legal advice, and the store's policies change: the policy text could not be checked from the
environment this was written in, so read the current developer program policies before submitting.

The same package is also published on GitHub Releases (see the README), which does not depend on store review.

## Single purpose

> Find the video, audio and files on the page you are viewing and save them to your computer, locally.

Everything the extension does serves that purpose: scanning the page, showing what can and cannot be saved, downloading
or recording it, and tidying the result (joining streams, extracting audio) with a bundled converter.

## What it does _not_ do (state this in the listing)

- It **does not bypass DRM, logins, paywalls or any site protection.** Widevine, PlayReady, FairPlay, SAMPLE-AES and
  EME-protected playback are detected and refused, for downloads, captures and recordings.
- It contains **no site-specific extractor** and no code for any particular streaming service. It reads what the page
  itself shows the user, plus a few standard, public interfaces (page metadata, and the public APIs of Wikimedia
  Commons, the Internet Archive and PeerTube on the page the user is on).
- It sends **nothing** to any server: no analytics, no telemetry, no remote configuration, no remote code.

## Permissions

### Granted at install

| Permission                    | Justification (suitable for the store form)                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                   | Lets the read-only scanner run on the tab the user opens the extension on, without any broad host access.               |
| `scripting`                   | Injects the scanner into that tab (and, with the user's permission, its embedded frames) when the user opens the popup. |
| `downloads`, `downloads.open` | Saves the files the user asks for with Chrome's download manager; opens or reveals a finished file at the user's click. |
| `storage`                     | Settings, the download queue and the scan result of each tab, kept on the device.                                       |
| `offscreen`                   | Joins stream segments and runs the bundled converter (service workers cannot create blob URLs or spawn workers).        |
| `notifications`               | Optional "finished" / "failed" notices (file name only). Can be switched off.                                           |
| `sidePanel`                   | The "Studio" panel where the user chooses output options.                                                               |

### Optional (requested at the moment of use, revocable)

| Permission                                            | When it is asked for, and why                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host access to one site (`optional_host_permissions`) | When the user presses _Allow site access_ or starts a download from a host that does not allow cross-origin reads, Never "all sites" for this.                                                                                                                                                                                                       |
| `declarativeNetRequestWithHostAccess`                 | Requested together with a site's access. A download of a file the host only serves with the `Referer`/`Origin` the browser itself sent for that frame needs those two headers, for the length of that one job. No other header is ever set.                                                                                                          |
| `webRequest` + all sites                              | Only if the user switches on _Scan pages automatically_ or _Observe media requests_. Response headers are read, never bodies; nothing is blocked or modified.                                                                                                                                                                                        |
| All sites (embedded players)                          | Only when the user presses _Allow all embedded players_ in the popup (shown when a page embeds players from sites not allowed yet) or switches on _Allow all sites and embedded players_ in Settings. One prompt; then the frames of every site can be scanned without asking again. Revocable in Settings.                                          |
| Page hook (_Look inside players_)                     | No permission of its own. On by default, registered only for the sites the user allowed (one by one or all sites). A read-only script runs in their frames at document start, to see manifests loaded by script, encrypted-media use, and the buffers of players that assemble video in memory. It sends nothing anywhere; the user can turn it off. |
| `nativeMessaging`                                     | Only when the user switches on _Hand downloads to the desktop app_ in Settings. It talks to the user's own vdown-helper desktop app (host `io.github.blacksoulgem95.vdownhelper`, registered by the app for this extension's ID only) to hand it downloads the user started. Given back when the option is switched off.                             |
| `cookies`                                             | Requested together with `nativeMessaging`. For a download from a site the user already allowed, that site's cookies are read and handed to the desktop app for that one download (the app keeps them in memory only). Never for a site the user did not allow; never sent anywhere else.                                                             |

`content_security_policy.extension_pages` is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
`wasm-unsafe-eval` is needed to run the bundled FFmpeg.wasm; there is no `unsafe-eval`, no inline script, no remote
script. `npm run check:dist` enforces this on every build.

## Data handling statement

- Collected: **nothing.** Settings, the queue and scan results live in `chrome.storage` on the device.
- Transmitted: **nothing.** The extension makes requests only to the media and files the user chose to save (and, for
  the open-site lookups and podcast feeds, to the page's own origin, anonymously).
- Sold, used for advertising or credit decisions: **no.**
- Remote code: **none.** The converter is part of the package; it is never downloaded.
- Logs never contain query strings, credentials or full addresses.

A privacy policy URL is normally required for extensions that handle "website content"; it can simply say the above.

## Risk assessment (read before submitting)

1. **Downloaders are a sensitive category.** The store's intellectual-property and "facilitating unauthorised access"
   rules mean extensions that download from particular services (video platforms in particular) are routinely
   rejected or removed. This one is general-purpose and refuses protected content, but a reviewer may still judge it by
   what it _can_ save. Rejection or later removal is a real possibility and cannot be ruled out from here.
2. **Broad optional host access and a page hook** draw extra review. Mitigations already in place: nothing broad at
   install; the all-sites access is optional, asked for only on the user's click, and revocable; the hook is read-only,
   runs only on sites the user allowed, and can be turned off; this document explains each one. Expect questions about the hook and about `declarativeNetRequestWithHostAccess`.
3. **A bundled GPL component** (FFmpeg.wasm core, GPL-2.0-or-later) is shipped inside an MIT-licensed extension. That is
   a licensing question for the project owner (see `THIRD_PARTY_NOTICES.md`); it is not a store-policy question, but
   a reviewer may ask. A build without the core is possible; merging and audio conversion are then unavailable.
4. **The listing must match the behaviour.** Do not describe it as downloading from any named service, do not claim
   to defeat protections, and do not promise that every video can be saved. The honest tables in the README
   ("Implemented vs unsupported", "Limitations") can be reused.
5. **If the store says no,** the zip from GitHub Releases installs through _Load unpacked_ (developer mode), or can be
   distributed in an organisation by policy. A signed `.crx` is not built (it needs a private key that must not live
   in the repository).

## Submission checklist

- [ ] Single purpose text above; listing text without any service names or promises of "all sites".
- [ ] Permission justifications copied from the tables above (install-time and optional).
- [ ] Privacy policy URL; data-use certification matching the statement above.
- [ ] Images from `store-assets/<lang>/` (`npm run store:assets`): five 1280 x 800 screenshots, the 440 x 280 tile and the
      1400 x 560 marquee, in English and Italian; 24-bit PNG without alpha.
- [ ] The package from the Release workflow (`vdown-helper-<version>.zip`), checksum recorded.
- [ ] Decision on the GPL component recorded by the project owner.
