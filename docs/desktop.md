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
- The app writes the host manifest for the current user at every launch, for each Chromium-family browser it finds;
  Settings has **Repair browser link**. Windows installers also write the registry keys; `.deb`/`.rpm` write the system
  folders.

| Browser  | Windows (HKCU\Software\…\NativeMessagingHosts) | macOS (~/Library/Application Support/…/NativeMessagingHosts) | Linux (~/.config/…/NativeMessagingHosts) |
| -------- | ---------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| Chrome   | `Google\Chrome`                                | `Google/Chrome`                                              | `google-chrome`                          |
| Chromium | `Chromium`                                     | `Chromium`                                                   | `chromium`                               |
| Edge     | `Microsoft\Edge`                               | `Microsoft Edge`                                             | `microsoft-edge`                         |
| Brave    | `BraveSoftware\Brave-Browser`                  | `BraveSoftware/Brave-Browser`                                | `BraveSoftware/Brave-Browser`            |
| Vivaldi  | `Vivaldi`                                      | `Vivaldi`                                                    | `vivaldi`                                |
| Opera    | `Opera Software`                               | `com.operasoftware.Opera`                                    | `opera`                                  |

- Extension side: optional `nativeMessaging` and `cookies` permissions, asked when the user turns the desktop app on.
  A `desktop` pipeline next to `native` and the offscreen document. The background re-derives URLs, headers and cookies
  from **its own scan**, as for every request; cookies only for `credentialedFor` origins.
- Routing setting: never / **streams and re-encodes** (default: every HLS/DASH stream and every re-encode go to the app,
  direct files stay Chrome downloads) / always. Every card also has **Send to desktop app**.
- Desktop jobs appear in the extension's queue with the same stages and an "In desktop app" badge.

#### Protocol v1

4-byte little-endian length + UTF-8 JSON, every message `{ "v": 1, "type": … }`. Messages to the browser stay under
1 MB (Chrome's limit).

| Direction | Type            | Payload                                                                          |
| --------- | --------------- | -------------------------------------------------------------------------------- |
| ext → app | `hello`         | `{ extVersion, userAgent }`                                                      |
| app → ext | `hello`         | `{ appVersion, ffmpeg: { version, encoders[] } }`                                |
| ext → app | `run-job`       | `{ jobId, request, plan, headers, cookies? }`                                    |
| app → ext | `progress`      | `JobProgress` (the extension's own type)                                         |
| app → ext | `done`          | `{ jobId, path, bytes }`                                                         |
| app → ext | `error`         | `{ jobId, code }` (`JobErrorCode`)                                               |
| ext → app | `cancel` …      | `cancel`, `pause`, `resume` `{ jobId }`                                          |
| app → ext | `needs-cookies` | `{ jobId, origins[] }`                                                           |
| ext → app | `cookies`       | `{ jobId, cookies[] }`                                                           |
| ext → app | `push-bytes`    | `{ jobId, seq, chunk, last }`: an MSE capture or recording handed over to encode |

The app validates every message: unknown types and versions are refused, DRM is re-checked on the app side even if a
request claims otherwise, and output paths stay inside the configured folder.

### Re-encoding (VDH-068)

Only in the app and only when the user asks. Presets ("Smaller file", "Compatible H.264 1080p", "AV1 archive"…) and
manual codec / resolution / quality / bitrate; hardware encoders (NVENC, Quick Sync, AMF, VideoToolbox, VAAPI) when a
test encode succeeds; trim with a preview player, timeline and keyframe snapping (lossless when the cut allows); MKV
output; soft subtitles; batch.

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
  resume after `kill -9`; DRM refused).
- The real app on Linux driven by tauri-driver against the same servers (`xvfb-run -a npm run test:desktop`, after
  `npm run desktop:ui` and `cargo build -p vdown-helper-desktop`): an HLS download, a DRM refusal, a live recording
  stopped from the queue, settings that survive a restart.
- Extension ↔ app in real Chromium with the host registered in the test profile.
- Installer smoke tests on each OS runner.
