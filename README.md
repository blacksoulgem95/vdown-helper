# vdown-helper

**Detect. Decode. Download.** · _YOUR MEDIA. YOUR CONTROL._

A Chrome (Manifest V3) extension that finds video and audio on the page you are viewing, shows what can really be
downloaded, and saves it locally: direct files through Chrome's download manager, HLS streams by fetching and joining
segments, and optional merging / audio extraction with a bundled FFmpeg.wasm. Everything runs on your machine; no URL
or browsing data is ever sent to a server.

| Popup                                         | Studio (side panel)                          |
| --------------------------------------------- | -------------------------------------------- |
| ![popup](docs/screenshots/popup-detected.png) | ![studio](docs/screenshots/studio-merge.png) |

It only downloads what the page already serves you and what you are allowed to save. It **does not** bypass DRM,
logins, paywalls or any other protection (see [Limitations](#limitations-read-this)).

---

## Contents

1. [Quick start](#quick-start)
2. [How to use it](#how-to-use-it)
3. [Implemented vs unsupported](#implemented-vs-unsupported)
4. [Output modes: copy vs transcode](#output-modes-copy-vs-transcode)
5. [Permissions](#permissions)
6. [Limitations (read this)](#limitations-read-this)
7. [Architecture](#architecture)
8. [Development and tests](#development-and-tests)
9. [Manual test procedure](#manual-test-procedure)
10. [Troubleshooting](#troubleshooting)
11. [Security and privacy](#security-and-privacy)
12. [Licence](#licence)

---

## Quick start

Requirements: Node.js **22.18+** (the build loads TypeScript config natively), npm, Google Chrome 116+.

```bash
npm install
npm run build          # produces dist/
npm run check:dist     # validates manifest, assets, locales, CSP, no remote code
```

Install in Chrome:

1. Open `chrome://extensions` and switch on **Developer mode**.
2. **Load unpacked** → choose the `dist/` folder.
3. Pin the extension, open a page that plays video, and click the icon.

`npm run build` also copies the FFmpeg.wasm core (≈ 31 MB) from `node_modules` into `dist/vendor/ffmpeg/`. It is
bundled with the extension and never downloaded at runtime.

## Releases and the Chrome package

`npm run package` builds the extension, runs the `dist/` checks and writes `release/vdown-helper-<version>.zip`
(+ a `.sha256`). `manifest.json` is at the root of the zip, source maps are excluded and the archive is reproducible:
the same commit gives the same SHA-256.

The **Release** workflow (`.github/workflows/release.yml`) runs on every push to `main` that changes more than docs
(`*.md`, `BACKLOG/`, `docs/` and `.claude/` are ignored): typecheck, lint, format, unit tests, build, `check:dist`,
package, then it uploads the zip as a build artifact, tags the commit `v<version>` and publishes a GitHub Release
with the zip and checksum attached. A re-run on a commit that already has a release tag publishes nothing new.

**The version is bumped automatically** (`scripts/next-version.mjs`):

| Situation                                                                                  | Version                                                                  |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| No release yet                                                                             | the version in `package.json` (first release: `0.1.0`)                   |
| Normal push to `main`                                                                      | latest `v*` tag + **patch** (`0.1.0` → `0.1.1`)                          |
| `#minor` or `#major` (or `[minor]` / `[major]`) in a commit message since the last release | minor (`0.1.5` → `0.2.0`) / major (`0.2.0` → `1.0.0`)                    |
| _Run workflow_ by hand                                                                     | choose `auto`, `patch`, `minor` or `major`                               |
| `package.json` is ahead of the result                                                      | `package.json` wins, so you can still jump to e.g. `1.0.0` by editing it |

Nothing is committed back to `main`: the released version lives in the tag, the zip name and the manifest inside the
zip (`VDH_VERSION` is injected at build time), so `package.json` keeps the _first/base_ version and a local
`npm run package` produces that base version.

Install a release: download `vdown-helper-<version>.zip`, unzip it, open `chrome://extensions`, enable _Developer
mode_, **Load unpacked** and pick the unzipped folder. The same zip is what the Chrome Web Store accepts for upload
(the store review and listing are separate steps this repository does not automate). A signed `.crx` is not built:
that needs a private signing key that must not live in the repo.

## How to use it

1. **Open the popup** on a page. It scans automatically (`SCANNING` → `READY`); `RESCAN PAGE` scans again, for example
   after you press play.
2. Each **card** shows the format, resolution, size (or `SIZE UNKNOWN`), duration, number of variants, and a status:
   `DOWNLOADABLE`, `PROTECTED`, `INACCESSIBLE`, `UNSUPPORTED` or `UNVERIFIED`, with the reason under `DETAILS`.
3. **`DOWNLOAD`** queues the item with your defaults (Settings). **`CONFIGURE`** opens the **Studio** side panel:
   choose output mode, stream variant, audio track, container/format, file name and "ask where to save", read what
   will happen (direct / join / FFmpeg copy / transcode), then press **START DOWNLOAD**. Nothing ever starts without
   a button press.
4. The **queue** shows stages (`DETECTED → PREPARING → DOWNLOADING → MERGING/ENCODING → COMPLETED`; only the stages
   a job really uses), real progress, speed and ETA when measurable, and pause / resume (native downloads only),
   cancel, retry, open and show-in-folder.
5. If a card says **INACCESSIBLE · cross-origin**, `ALLOW SITE ACCESS` asks Chrome for access to _that one site_ and
   rescans.
6. **Settings** (gear icon): default mode, quality preset, audio format and bitrate, naming template, sub-folder,
   concurrency, memory/encode limits, notifications, auto-scan, network observer, clear history, reset.

The UI is available in English and Italian (follows Chrome's UI language).

## Implemented vs unsupported

Everything in the _implemented_ column is covered by automated tests; items marked † were verified in real Chromium
only under the conditions described in [Development and tests](#development-and-tests).

| Area         | Implemented                                                                                                                                                                                                                    | Not supported / not included                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Detection    | `<video>`/`<audio>` (`currentSrc`, `src`, `<source>`), media links, Performance timeline entries, open shadow roots, same-origin iframes; optional `webRequest` observer (finds requests from workers/frames) †                | Cross-origin iframes, closed shadow roots, DRM/EME players, `blob:`/MSE streams (counted and explained, never "detected" as a file) |
| Direct files | MP4, WebM, MKV, MOV, OGV, MP3, M4A, AAC, WAV, OGG, FLAC via Chrome's download manager; size/type from headers when readable; pause/resume/cancel/retry †                                                                       | Files that require headers or cookies Chrome's download manager cannot send                                                         |
| HLS parsing  | master and media playlists, `EXT-X-STREAM-INF`, `EXT-X-MEDIA` (audio), `EXTINF`, `EXT-X-MAP`, `EXT-X-BYTERANGE`, `EXT-X-KEY`, relative/absolute URLs, VOD vs live; plain M3U, DASH and malformed input are told apart from HLS | I-frame-only streams (ignored), subtitles (not downloaded), DASH/MPD                                                                |
| HLS download | ordered segment fetch with retries, concurrency, cancel; staged on disk (OPFS); MPEG-TS and fMP4; **AES-128** decrypted when its key is fetchable †                                                                            | **DRM** (Widevine, FairPlay, PlayReady), **SAMPLE-AES**, live/event streams                                                         |
| Processing   | stream-copy remux (TS→MP4/MKV), merge of separate video+audio, video-only, audio extract to **M4A/AAC (copy when the source is AAC)**, **MP3/WAV (transcode)** with 128/192/256/320 kbps †                                     | Re-encoding **video** (never done), upscaling, hardware encoders, files larger than the memory limit                                |
| UI           | popup, Studio side panel, options, EN/IT, keyboard operable (native buttons/inputs, visible focus ring), reduced-motion aware                                                                                                  | Thumbnails for streams (only a page-provided poster, from the page's own site)                                                      |
| Safety       | URL scheme allow-list, file-name sanitiser (+ ASCII fallback), no remote code, redacted logs, validated messages, least-privilege permissions                                                                                  | —                                                                                                                                   |
| Companion    | architecture documented in [`docs/native-companion.md`](docs/native-companion.md)                                                                                                                                              | **The companion app itself is not built**                                                                                           |

## Output modes: copy vs transcode

The Studio says which of these will happen _before_ you start. Video is **never** re-encoded.

| You choose                                          | Source                     | What happens                                                    | Quality                       |
| --------------------------------------------------- | -------------------------- | --------------------------------------------------------------- | ----------------------------- |
| Original / Video+Audio, same container              | direct file                | Chrome downloads it as is                                       | identical                     |
| Original, HLS with muxed audio (TS or fMP4)         | HLS                        | segments are joined on disk, no FFmpeg                          | identical                     |
| MP4 / MKV container                                 | any with compatible codecs | FFmpeg.wasm **stream copy**                                     | identical                     |
| Video+Audio with a **separate audio rendition**     | HLS                        | FFmpeg.wasm **merge** (copy both)                               | identical                     |
| Video only                                          | any                        | FFmpeg.wasm copy without audio (native when already video-only) | identical                     |
| Audio only → **M4A / AAC**                          | AAC audio                  | stream **copy** (no bitrate option shown)                       | identical                     |
| Audio only → **M4A / AAC**                          | other codec                | audio **transcode** to AAC at 128–320 kbps                      | re-encoded                    |
| Audio only → **MP3**                                | any                        | audio **transcode** (libmp3lame) at 128–320 kbps                | re-encoded                    |
| Audio only → **WAV**                                | any                        | decode to PCM, no bitrate option                                | lossless decode of the source |
| Container the codec cannot go into (e.g. VP8 → MP4) | —                          | **refused**: needs video re-encoding, which is not supported    | —                             |

Options that are not valid for the selected source are disabled, with the reason shown.

## Permissions

Installed with the extension:

| Permission                    | Why                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `activeTab`                   | Temporary access to the tab you open the extension on, so the read-only scanner can run. No broad host access is requested at install. |
| `scripting`                   | Injects the scanner (`content.js`) on demand. It only reads; it never changes the page.                                                |
| `downloads`, `downloads.open` | Saves files with Chrome's download manager; opens / reveals a finished file.                                                           |
| `storage`                     | Settings, the download queue and per-tab scan results, on this device.                                                                 |
| `offscreen`                   | A hidden page that joins segments and runs FFmpeg.wasm (service workers cannot create blob URLs or spawn workers).                     |
| `notifications`               | Optional completion/failure notifications (file name only).                                                                            |
| `sidePanel`                   | The Studio panel.                                                                                                                      |

**Optional** (asked for only when you use the related feature, revocable in Settings):

| Permission                      | When                                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access to a specific site       | When a stream's host does not allow cross-origin reads (`ALLOW SITE ACCESS`, or when starting an HLS download). Requested for that site only. If the site already allows cross-origin reads, you are not asked. |
| `webRequest` + all-sites access | Only if you enable **Scan pages automatically** or **Observe media requests** in Settings. The observer reads response headers (never bodies); nothing is blocked or modified.                                  |

Content-Security-Policy for extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.
`wasm-unsafe-eval` is required to instantiate FFmpeg.wasm; there is no `unsafe-eval`, no inline script and no remote
code (`npm run check:dist` enforces this).

## Limitations (read this)

- **Not every stream can be seen.** Chrome extensions cannot inspect every request or every player. Detection relies
  on what the page exposes (DOM, Performance timeline) plus, if you opt in, response headers via `webRequest`.
  Players that assemble video in memory with MSE (`blob:` URLs), cross-origin iframes and closed shadow roots are
  invisible or only counted.
- **Cross-origin rules (CORS).** The scanner reads with the page's own origin and cookies, exactly like the page's
  player. Downloading segments happens from the extension, which is subject to CORS unless you grant that site. A
  `403`/CORS failure is shown as such; it is never hidden or retried forever. Fetch failures cannot distinguish "CORS
  refused" from "network down" (a browser limitation), so the message says both.
- **Authenticated media.** Cookies are sent only to the origin of the page you are on, never to other hosts a
  playlist mentions (those are fetched anonymously). Streams that need custom headers,
  tokens injected by page scripts, or short-lived signed URLs may fail or expire between detection and download.
- **Encrypted HLS.** Plain **AES-128** (key URL fetchable by the page itself) is decrypted, as any player would.
  **SAMPLE-AES, Widevine, FairPlay, PlayReady and any other DRM are detected and refused**; there is no workaround
  and none is planned.
- **Live/event streams** (no `#EXT-X-ENDLIST`) are refused; only finished (VOD) streams download.
- **Browser memory.** HLS joined as TS/fMP4 is staged on disk (OPFS), but FFmpeg.wasm holds its output in memory.
  The default cap is **2048 MB** (Settings); jobs estimated above it are refused with an explanation instead of
  crashing the tab. wasm FFmpeg is single-threaded and slow: expect high CPU use on long videos.
- **Browser-managed downloads.** Chrome chooses the Downloads folder (you can add a sub-folder, or ask "Save as").
  Pause/resume exists only for native downloads; segment/FFmpeg jobs can be cancelled and retried but not paused.
  Chrome may reject unusual file names; the extension then retries with an ASCII-only name.
- **Native messaging.** Not used. A companion app for very large files is documented
  ([`docs/native-companion.md`](docs/native-companion.md)) but **not built**.
- **Estimated sizes** for HLS are `bandwidth × duration` and are always shown with `≈`.

## Architecture

```
manifest.json            MV3 manifest (version is injected from package.json at build time)
_locales/{en,it}         chrome.i18n catalogs (a test enforces identical keys and placeholders)
src/
  background/            service worker: detect.ts (scan orchestration), pageFetch.ts (page-origin fetch via
                         scripting), observer.ts (optional webRequest), runner.ts (queue, chrome.downloads,
                         offscreen bridge), jobStore.ts, tabState.ts, notify.ts
  content/scanner.ts     read-only page scanner, injected on demand (IIFE)
  offscreen/             hls.ts (segment fetch, AES-128, OPFS staging), ffmpeg.ts (FFmpeg.wasm), jobs.ts
  popup/ options/ sidepanel/   React UIs (sidepanel = "Studio")
  components/ hooks/     shared UI and React hooks
  lib/                   pure logic: hls/ (parser), analyze.ts, compat.ts (output planner), request.ts,
                         queue.ts (state machine), settings.ts, security.ts, media.ts, resources.ts, messaging.ts
  types/ styles/         shared types; Tailwind theme (cyberpunk tokens, bundled fonts)
scripts/                 build.mjs, check-dist.mjs, make-icons.mjs, backlog.mjs
e2e/                     Playwright suite, fixture generator, local servers
BACKLOG/                 task files (status tracked per .claude/rules/backlog.md)
```

Flow: popup → `scan` → service worker injects `content.js` → candidates → each is probed _from the page's origin_
(playlists parsed by `lib/hls`) → verdict (`downloadable | protected | inaccessible | unsupported | unknown`) →
stored per tab. `DOWNLOAD`/`START` → `start-download` → the background **re-validates everything** (URLs, file
names, DRM, live, limits) with the same planner (`lib/compat.ts`) → queue → native `chrome.downloads`, or the offscreen
document (segments → OPFS → optional FFmpeg.wasm → blob URL → `chrome.downloads`).

## Development and tests

```bash
npm run typecheck      # strict TypeScript
npm run lint           # ESLint (bans dangerouslySetInnerHTML, eval, any)
npm test               # Vitest: 250+ unit tests
npm run build && npm run check:dist
npm run test:e2e       # real Chromium + fixtures + ffprobe verification (needs ffmpeg/ffprobe on PATH)
npm run serve:fixtures # the E2E fixture sites, for manual testing
```

**Unit tests** cover HLS master/media parsing, relative URLs, invalid manifests, dedupe, file-name sanitising, queue
state transitions and retry, failed downloads, unsupported formats, audio/video container compatibility, the output
planner, FFmpeg argument building, request validation, settings persistence/clamping, message validation, the content
scanner (jsdom) and i18n catalog parity.

**End-to-end tests** (`e2e/run.mjs`) load the production build unpacked in Chromium and verify, with real files
inspected by `ffprobe`/`ffmpeg`: detection and classification, direct MP4 download, HLS concatenation (fully decodable),
AES-128 decryption (including encrypted fMP4 init sections), a server that ignores `Range`, a server that stalls, CORS-open CDN, merge of separate audio/video via FFmpeg.wasm, MP3 transcode (bitrate checked),
AAC→M4A copy, WAV, TS→MP4 remux, FFmpeg progress events on a 5-minute encode, pause/resume, cancel (no file produced),
failure → retry, the memory guard (a 140 MB stream is refused for MP4 but saved as TS), DRM and unsafe-input refusal,
empty and restricted pages, every popup control, keyboard focus order, settings persistence, a forced service-worker
shutdown, the opt-in observer and auto-scan, the Italian UI, **zero console errors in the
service worker, offscreen document, popup, options and side panel**, and that no request left the two local origins.

What the automated run does **not** prove (verify manually, see below):

- The browser's **permission prompts** for optional access cannot be clicked by automation. The E2E build is the
  production build plus `host_permissions` for the test site and `webRequest`, which stand in for those grants.
- The real **toolbar popup** and `activeTab` grant (tests open the popup page in a tab and pass `?tabId=`) and
  `chrome.sidePanel.open()` from the popup (tests open the side-panel page directly).
- Branded **Google Chrome** (tests use Chromium) and non-Linux platforms.
- Real-world sites and very large files.

## Manual test procedure

Start the fixture sites (`npm run serve:fixtures`) and load `dist/`. Open the printed _page_ URL, click the
toolbar icon.

1. **Direct MP4** — card "Sample clip", `DIRECT FILE`, real size. `DOWNLOAD` → completes; open the file; it plays,
   has audio. Pause/resume needs a download that lasts a few seconds: open `<site>/__slow/file.bin` (a throttled
   2 MB file) in a tab; it is also covered by the E2E suite.
2. **Accessible HLS** — `HLS MASTER` card (same-origin). `DOWNLOAD` → a `.ts` file that plays. In **Configure** choose
   MP4 → the summary says "FFmpeg.wasm copies the streams… No re-encoding" and `MERGING` appears in the queue.
3. **Multiple quality variants** — Studio lists exactly the variants in the playlist (360p and 180p for the fixture;
   never more). Pick 180p; the file's resolution is 320×180.
4. **Separate audio** — the `hls-sep` card: Studio shows an _Audio track_ picker; MP4 output needs the merge.
5. **Cross-origin failure** — the `closed/` CDN card shows `INACCESSIBLE`, the reason, and `ALLOW SITE ACCESS`
   (grant it in Chrome's prompt, the card rescans). The `open/` CDN card downloads without any prompt.
6. **Unsupported sources** — `PROTECTED` (SAMPLE-AES), `UNSUPPORTED` (live, plain M3U, DASH): `DOWNLOAD` is disabled
   and the reason is explained; Studio refuses to start.
7. **Encryption** — the AES-128 card downloads and the video plays (a wrong key would produce garbage).
8. **Retry** — "flaky" playlist fails with `HTTP 404`; run `curl -X POST <site>/__flaky/enable`, press retry.
9. **Large download** — set _Memory limit_ to 128 MB in Settings, then convert anything ≥ 128 MB with MP4 → refused with
   the explanation; the same stream as TS/original still downloads (disk-backed). With a real multi-GB VOD, confirm the
   tab stays responsive and cancel works.
10. **Opt-in features** — enable _Scan pages automatically_: grant the prompt, reload a page, the icon shows a count.
    Enable _Observe media requests_, open `/pages/worker.html`: the worker's manifest appears with source "Network
    observer". _Revoke all-sites access_ removes both.
11. **Keyboard** — Tab through popup/Studio/Settings: every control is reachable, has a visible focus ring, toggles and
    radios work with Space/Enter.

## Troubleshooting

| Symptom                                                | Cause / fix                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Chrome did not allow access to this tab"              | Browser pages, the Web Store and `file://` cannot be scanned. On a normal page, open the extension from the toolbar _on that page_ (grants `activeTab`).              |
| `NO MEDIA DETECTED` but a video plays                  | The player uses MSE/`blob:` (see the note on the page) or an iframe from another site. Press play, then `RESCAN PAGE`; try enabling the network observer in Settings. |
| `INACCESSIBLE · cross-origin`                          | The host blocks reads from other origins. Use `ALLOW SITE ACCESS`.                                                                                                    |
| Job fails: "Blocked by the site's cross-origin policy" | Same cause at download time. Grant access and retry.                                                                                                                  |
| Job fails with `HTTP 403/410`                          | Signed URLs usually expire. Rescan and start again; if the site needs special headers it is not supported.                                                            |
| `PROTECTED`                                            | DRM or SAMPLE-AES. Not supported by design.                                                                                                                           |
| "Estimated size exceeds your memory limit"             | Raise _Memory limit_ (Settings), or choose TS/Original (disk-backed).                                                                                                 |
| Conversion is slow / fan spins                         | FFmpeg.wasm is single-threaded. Prefer stream-copy options (MP4/MKV) over audio re-encode on long videos.                                                             |
| File name looks different from the template            | Names are sanitised; characters Chrome rejects are folded to ASCII; Chrome adds `(1)` if the file exists.                                                             |
| Extension errors after update                          | `chrome://extensions` → reload the extension, then reload the page you want to scan.                                                                                  |
| Need logs                                              | Service worker: `chrome://extensions` → _Inspect views_. Logs never contain query strings or credentials.                                                             |

## Security and privacy

- **Local only.** No analytics, no remote config, no remote code, no external requests (the E2E run asserts this).
- **Least privilege.** Nothing broad at install; per-site and all-sites access are optional and revocable.
- **Hostile input is assumed.** Page-derived strings are rendered as React text (never HTML); URL schemes are
  allow-listed (`http`/`https`); file names and sub-folders are sanitised twice (UI and background) against path
  traversal, reserved names and control/bidi characters; every message is validated and must come from this
  extension; the background re-checks DRM, live status and size limits no matter what the UI sent.
- **No confused deputy.** Extension-origin requests (the only ones exempt from CORS) never carry cookies to other
  sites, never target loopback / private-network / `.local` hosts on behalf of a public page, and are never made
  during an automatic scan. Responses are bounded in size, time and count, so a hostile playlist or server cannot
  exhaust memory, disk or a download slot.
- **Logs are redacted** (query strings and credentials removed from every logged URL).
- **Protected content stays protected.** DRM/SAMPLE-AES streams are refused in the UI _and_ in the background.
- You are responsible for having the right to save what you download.

## Licence

Application code: **MIT** (`LICENSE`). The bundled FFmpeg.wasm core is **GPL-2.0-or-later**; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) before redistributing a package that contains it.

Project tracking lives in [`BACKLOG/`](BACKLOG/README.md).
