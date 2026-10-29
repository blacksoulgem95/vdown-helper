# vdown-helper desktop app

> Status: **in development** (backlog VDH-061 to VDH-069). The extension works without it. This page is the agreed design;
> each section says which task builds it.

## Why it exists

A Chrome extension runs in a sandbox. Three limits cannot be removed from inside it:

| Limit          | In the extension                                                                                                        | In the desktop app                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Memory         | FFmpeg.wasm keeps input and output in memory: joining separate audio and video is refused above the cap (default 2 GB). | Native `ffmpeg` reads and writes on disk: no size limit.                    |
| Codecs / speed | Video is only ever stream-copied; wasm FFmpeg is single-threaded.                                                       | Remux by default, optional re-encode (x264/x265, hardware encoders), fast.  |
| Lifetime       | Jobs stop when the browser closes; segment jobs cannot be paused.                                                       | A persistent queue that keeps running in the tray, resumes after a restart. |

The app is also a download manager on its own: paste a media or playlist URL, scan a page's HTML, or drop local files.

## What it will and will not do

- It only saves what the user is allowed to access. **DRM is refused** exactly as in the extension (Widevine, PlayReady,
  FairPlay, SAMPLE-AES, EME-protected playback), with the same code: the parsers and DRM verdicts are one Rust crate,
  compiled to wasm for the extension and used natively by the app. AES-128 HLS and ClearKey (openly delivered keys) are
  allowed and labelled.
- No site-specific extractors. The page scan reads the HTML once (`<video>`, `<source>`, playlist and media links,
  `og:video`); it runs no scripts and follows no iframes. Players built by JavaScript go through the extension's hand-off.
- No telemetry. The one network call that is not media the user chose is the **update check** (GitHub Releases only, no
  identifiers, no browsing data; on by default, can be turned off in Settings; installs only after the user confirms).
- Cookies: when the extension hands over a stream from a site the user granted, it may pass that site's cookies **for
  that one job**. The app keeps them in memory only, never writes or logs them. After an app restart such a job waits
  for the browser to supply them again.
- The app fetches any http(s) address the job names, local network included (the extension keeps its own guard). It
  uses the system proxy and sends the User-Agent the browser passed (a generic one for standalone jobs).

## Architecture

```
core/            vdh-core: pure Rust port of src/lib (parsers, DRM verdicts, planner, ffmpeg arguments, requests,
                 security helpers...). No I/O.
core-wasm/       wasm-bindgen wrapper; npm run build compiles it for the extension (src/wasm/, generated)
desktop/
  engine/        vdh-engine: fetching, HLS/DASH/AES-128, live recording, ffmpeg runner, SQLite queue and history,
                 bandwidth cap, schedule. Also the `vdh` CLI used by the tests.
  src-tauri/     Tauri v2 shell: commands, tray, notifications, start at login, updater, native-host relay mode
  ui/            React + Vite; reuses src/components, the theme, fonts and the en/it catalogs
  ffmpeg.lock.json   pinned ffmpeg/ffprobe builds (URL + SHA-256 per target)
```

```
┌──────────────────┐ connectNative  ┌──────────────────┐  local IPC (user-only  ┌───────────────────────────┐
│ extension        │ ── stdio ────▶ │ relay process    │ ── pipe / socket) ───▶ │ vdown-helper app (tray)   │
│ service worker   │ ◀───────────── │ (started by      │ ◀───────────────────── │ queue, engine, ffmpeg     │
└──────────────────┘  length+JSON   │  the browser)    │                        └───────────────────────────┘
                                    └──────────────────┘
```

The browser only ever owns the relay. The relay starts the app if it is not running, so jobs outlive the browser.

### Shared core (VDH-062 to VDH-064)

Every pure module of `src/lib` moves to `vdh-core`. TS modules become thin wrappers with the same exports, so callers
do not change. `scripts/build-core.mjs` (run by `npm run build`, `npm test` and `npm run typecheck`) compiles
`core-wasm` and the pinned `wasm-bindgen` CLI writes the glue to `src/wasm/gen/` (generated, not committed) with the
`.wasm` inlined as base64: `src/lib/core.ts` instantiates it **synchronously** in every context (service worker,
offscreen document, pages, unit tests), so nothing is fetched and no caller has to wait.

The shapes crossing the boundary are the TypeScript types in `src/types`; they are held to the Rust types by golden
fixtures recorded from the former TypeScript implementation (`core/fixtures/golden/*.jsonl`), replayed by `cargo test`
natively and by `tests/core-golden.test.ts` through the wasm. The existing vitest suites keep running against the wasm.

### Engine (VDH-065, queue VDH-075)

- `vdh` CLI: `vdh probe <url>`, `vdh get <url> -o DIR` (a live stream records until it ends or Ctrl+C), `vdh run
<request.json>` (a request as the extension hands it over). The integration tests drive it against the E2E fixture
  servers (`e2e/fixture-server.mjs`).
- Every request is planned again by `vdh-core` and every playlist or manifest is checked for DRM by the engine itself;
  standalone addresses are probed into the same resource the extension's scan builds, so requests are built alike.
- `reqwest` (rustls with the system's certificate store, system proxy); per-job Referer/Origin/User-Agent; redirects
  only to http(s).
- Segments fetched concurrently into a job folder; progress and byte ranges recorded in SQLite so a job resumes after
  a crash or restart. AES-128 with the `aes` + `cbc` crates.
- `ffmpeg` / `ffprobe` are sidecar processes. Argument vectors come only from `vdh-core` (a closed set of operations:
  copy, merge, audio extract/convert, transcode presets, trim, subtitle embed); never a shell. Progress from
  `-progress pipe:1`.
- Queue (`vdh queue add|list|run|pause|resume|retry|cancel|stop|remove`, `vdh history`): 3 jobs at a time, 4 segments
  each by default; jobs and the checkpoints of their staged tracks in SQLite, so a job continues after the app is closed
  or killed; requests to pause or cancel are written to the database and reach the running queue from any process;
  global bandwidth cap; schedule window (local time); history kept until cleared, can be turned off (URLs stored with
  credentials and tokens stripped); folder rules like `{type}/{host}/{title}` under `~/Downloads/vdown-helper` (with
  the app, VDH-076); filenames sanitised with the extension's rules.

### App (VDH-066; page scan, local files, clipboard and folder rules VDH-076)

- `desktop/src-tauri` (Tauri v2): the queue runs in the app's process (`Manager::run`), with its database and staging
  in the app's data folder; finished files go to `Downloads/vdown-helper` unless the user picks a folder.
- The window (`desktop/ui`, built by `npm run desktop:ui`) talks to the app only through its own commands: `probe` and
  `add` take an address and the user's choices, and the app probes the address itself before queueing it (the window's
  description is never trusted); `jobs`, `control` (pause, resume, retry, cancel, stop, remove), `history`,
  `get_settings` / `save_settings`, `pick_folder`, `open_file` (only files the queue finished). The window has no file
  system, shell or HTTP access; its CSP allows only its own files and the core's wasm.
- The window reuses the extension's components (`QueueItem`, `Tabs`, fields), theme, fonts, Rust core and catalogs;
  the app's own strings are in `desktop/ui/locales/{en,it}.json` (also used for the tray and notifications). The
  language follows the system unless the user picks one.
- Settings live in the queue database and apply while jobs run (jobs and segments at a time, bandwidth cap, schedule
  window, history on/off). Closing the window keeps the app and its jobs in the tray (can be turned off); quitting holds
  the running jobs, which continue at the next start. Start at login is off until the user turns it on. A second launch
  brings the running app forward. A notification when a job finishes or fails (can be turned off).

### Native link (VDH-067)

- Host name `io.github.blacksoulgem95.vdownhelper`; `allowed_origins` is the extension's ID, which `manifest.json`
  pins with its `key` (unpacked installs and the store build share it).
- The app writes the host manifest for the current user at every launch, for each Chromium-family browser whose folder
  exists (on Windows: a manifest in its data folder and a key per browser under HKCU); Settings has **Repair browser
  link** and lists the browsers found. An AppImage registers the AppImage itself (its mount moves at every launch).

| Browser  | Windows (HKCU\Software\…\NativeMessagingHosts) | macOS (~/Library/Application Support/…/NativeMessagingHosts) | Linux (~/.config/…/NativeMessagingHosts) |
| -------- | ---------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Chrome   | `Google\Chrome`                                | `Google/Chrome`                                              | `google-chrome`                          |
| Chromium | `Chromium`                                     | `Chromium`                                                   | `chromium`                               |
| Edge     | `Microsoft\Edge`                               | `Microsoft Edge`                                             | `microsoft-edge`                         |
| Brave    | `BraveSoftware\Brave-Browser`                  | `BraveSoftware/Brave-Browser`                                | `BraveSoftware/Brave-Browser`            |
| Vivaldi  | `Vivaldi`                                      | `Vivaldi`                                                    | `vivaldi`                                |
| Opera    | `Opera Software`                               | `com.operasoftware.Opera`                                    | `opera`                                  |

- Relay: the browser starts the app's own binary with the extension's origin on its command line. That process only
  connects to the running app's local socket (a socket in a folder only the user can enter, or a named pipe on Windows)
  and passes frames through, starting the app in the tray first when it is not running. The browser only ever owns the
  relay: closing it never stops the app or its jobs.
- Extension side: optional `nativeMessaging` and `cookies` permissions, asked when the user switches on _Hand downloads
  to the desktop app_ in Settings (and given back when it is switched off). Jobs for the app are marked `viaDesktop`;
  the background re-derives URLs, headers and cookies from **its own scan**, as for every request; the Referer/Origin
  are the ones it would replay itself; cookies only for `credentialedOrigins`, and only for sites the user granted.
- Routing setting: only what I send there / **streams and conversions** (default: every HLS/DASH stream and every
  download that needs FFmpeg) / everything it can take. Every card also has **Send to desktop app**. Page-held media
  (captures, recordings of a page, `blob:`), ZIPs of page files and subtitles always stay in the browser (handing
  captures and recordings to the app for re-encoding is VDH-077).
- Desktop jobs appear in the extension's queue with the app's stages, its progress (a few times a second) and an
  "In desktop app" badge; pause, resume, stop and cancel go to the app. The port is open only while the app runs a job
  for the extension. After the service worker restarts it asks the app where its jobs are (`status`).
- Jobs keep the extension's id in the app. Cookies are never stored: after the app restarts, a job that was given
  cookies waits, and the app asks the browser for them again (`needs-cookies`).

#### Protocol v1

4-byte little-endian length + UTF-8 JSON, every message `{ "v": 1, "type": … }`. Messages to the browser stay under
1 MB (Chrome's limit).

| Direction | Type            | Payload                                                                                                                                   |
| --------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| ext → app | `hello`         | `{ extVersion, userAgent }`                                                                                                               |
| app → ext | `hello`         | `{ appVersion, ffmpeg }` (ffmpeg's version, or `null` when there is none)                                                                 |
| ext → app | `run-job`       | `{ jobId, request, headers: { referer, origin, userAgent }, cookies?: [{ origin, header }] }`                                             |
| app → ext | `accepted`      | `{ jobId, stages }` (the app's plan; a job handed over again after it ended is retried)                                                   |
| app → ext | `stage`         | `{ jobId, stage }` (never the end: that comes as `done`, `error` or `cancelled`)                                                          |
| app → ext | `progress`      | `{ jobId, progress }` (`JobProgress`, the extension's own type)                                                                           |
| app → ext | `done`          | `{ jobId, path, bytes }`                                                                                                                  |
| app → ext | `error`         | `{ jobId?, code, message }` (`JobErrorCode`)                                                                                              |
| app → ext | `cancelled`     | `{ jobId }`                                                                                                                               |
| ext → app | `pause` …       | `pause`, `resume`, `stop` (a live recording), `cancel` `{ jobId }`                                                                        |
| ext → app | `status`        | `{ jobIds }`; the app answers `status { jobs: [{ jobId, stage, paused, progress, path, error }] }` (`gone` when it does not know the job) |
| app → ext | `needs-cookies` | `{ jobId, origins }`                                                                                                                      |
| ext → app | `cookies`       | `{ jobId, cookies: [{ origin, header }] }`                                                                                                |

The app validates every message: unknown types, fields and versions are refused; a request must plan, name http(s)
addresses and carry no page-held media; cookies are kept only for the origins the request names as credentialed;
DRM is re-checked by the engine on the playlists it reads itself whatever the request claims; output names are
sanitised and stay inside the download folder.

### Re-encoding (VDH-068)

Only in the app and only when the user asks: the **Convert** tab, or **Re-encode** on a finished download in the
History. The original file is never written; the new one goes to the download folder as `name [label].ext` (the label
is the preset's name or the encode's short name, `H.265 720p`), never over an existing file.

- **What can be chosen** is a closed set in `vdh-core` (`core/src/transcode.rs`): container (MP4, MKV, WebM), video codec
  (H.264, H.265, AV1, VP9, or keep the video as it is), encoder, constant quality or average bitrate, a maximum height
  (never scaled up) and the audio (keep, AAC, Opus, none). `check()` refuses what a container cannot hold (VP9 or Opus
  in MP4, H.264/H.265 or AAC in WebM; Matroska holds them all), out-of-range values and resizing a kept video, with a
  stable code the window words in the user's language; the app checks again whatever the window sends.
- **Presets** are starting points the controls then change: Compatible (H.264/AAC MP4 up to 1080p), Smaller (H.265),
  Phone (H.264 up to 720p), Web (VP9/Opus WebM up to 1080p), Archive (AV1/Opus MKV).
- **Encoders.** Software ones (libx264, libx265, libsvtav1, libvpx-vp9) are offered when ffmpeg lists them; hardware
  ones (NVENC, Quick Sync, AMF, VideoToolbox, VAAPI) only after a one-frame test encode succeeds (ffmpeg lists them
  whether or not a device and driver are there). Detection runs once, the first time the Convert tab opens.
- **Jobs.** Each file is a queue job with the stages detected → preparing → encoding → completed, real progress from
  ffmpeg's `-progress` against the input's duration (ffprobe), and pause, cancel, retry and remove like any job. A
  paused encode starts again from the beginning (ffmpeg cannot continue a half-written file). Only files the queue
  finished or the user picked in the file dialog can be re-encoded; batches are up to 50 files.
- **From a terminal:** `vdh encode <file> --preset smaller -o DIR` (or `--codec`, `--container`, `--encoder`, `--crf`
  / `--kbps`, `--height`, `--audio`), `vdh queue add-encode …` and `vdh encoders`.

FFmpeg 8.0 logs `Error parsing Opus packet header` whenever it reads the last (end-trimmed) Opus packet of a WebM/MKV
file, although the stored bytes are correct (the same packet decodes cleanly from Ogg; VDH-081): the engine tests copy
the video and the Opus packets unchanged into files of their own and decode each in full.

Trim with a preview player, timeline and keyframe snapping is VDH-079; subtitles embedded as soft subs are VDH-080.

### Packaging (VDH-069)

| Target          | Bundles                                  | Auto-update                         |
| --------------- | ---------------------------------------- | ----------------------------------- |
| Windows x64     | MSI, NSIS `.exe`                         | yes                                 |
| Windows arm64   | MSI, NSIS `.exe`                         | yes                                 |
| macOS universal | `.dmg` (+ `.app.tar.gz` for the updater) | yes                                 |
| Linux x64       | AppImage, `.deb`, `.rpm`                 | AppImage; `.deb`/`.rpm` notify only |

Minimum: Windows 10 1809, macOS 11, Ubuntu 22.04 (webkit2gtk-4.1). Builds are unsigned until certificates exist (the
signing steps are wired and skipped). The bundled ffmpeg is a pinned **GPL** build (x264/x265), verified by SHA-256 in
CI and shipped as a separate program; installers and About carry its licence and a link to its source. The app's own
code is MIT.

Releases are tagged `desktop-vX.Y.Z` (patch for a merge that touches `core/` or `desktop/`; `#desktop-minor` /
`#desktop-major` on a line of their own raise it). The updater reads `latest.json` from the rolling `desktop-latest`
release.

## Tests

- `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` on Linux, Windows and macOS; golden fixtures shared with
  the extension's vitest suites.
- The engine's integration tests against the E2E fixture servers (outputs checked with ffprobe and a full decode;
  resume after `kill -9`; DRM refused; re-encodes checked for their codecs, size and duration, a paused encode
  finishing after it is resumed).
- The real app on Linux driven by tauri-driver against the same servers (`xvfb-run -a npm run test:desktop`, after
  `npm run desktop:ui` and `cargo build -p vdown-helper-desktop`), in its own D-Bus session: an HLS download and its
  notification, a DRM refusal, a live recording stopped from the queue, a finished download re-encoded to H.265 in
  MKV and a batch with the Compatible preset (codecs checked with ffprobe, the original unchanged), settings that
  survive a restart, start at login, closing the window to the tray (a real `WM_DELETE_WINDOW`) and a second launch bringing it back.
- Extension ↔ app in real Chromium (`xvfb-run -a dbus-run-session -- npm run test:link`): the app registers itself with the test
  profile, the browser starts it through the relay, an HLS stream and a card sent with **Send to desktop app** are
  saved by the app, a cookie-protected file is fetched with the cookie of the granted site, cancel reaches the app, a
  forged request for a DRM stream is refused by the app, and a job finishes after the browser closed.
- Installer smoke tests on each OS runner.
