# vdown-helper

> Detect. Decode. Download. — YOUR MEDIA. YOUR CONTROL.

Chrome Manifest V3 extension (TypeScript, React, Vite, Tailwind) that detects media and files on a page
(direct files, HLS, MPEG-DASH, subtitles, images/documents, `blob:`/MSE players, MediaStreams, live streams, in every
frame) and downloads, captures or records them locally with an optional FFmpeg.wasm pipeline.

## Working agreement

- **All work is tracked in `BACKLOG/`.** Read `.claude/rules/backlog.md` before starting any task.
- Develop on the branch named in the session instructions; commit per backlog stage with the task
  ID in the subject (`VDH-005: HLS parser`).
- **Every completed stage goes to `main` through a new PR, which is then merged** (the owner's standing instruction): open a
  new PR from the session branch (never reuse a merged one), **run the full suite locally on the PR's exact head**
  (`typecheck`, `lint`, `format:check`, `test`, `build`, `check:dist`, `test:e2e`, plus the `cargo` checks once Rust exists), wait for CI (`check`, `e2e` and the `Desktop` workflow) to be
  green on that head, then merge it with a merge commit. A red or conflicting PR is fixed first, never merged red. Merging to `main` publishes a
  release: patch by default; put `#minor` / `#major` on a line of its own in the merge commit message (or `[minor]` /
  `[major]` in a commit subject) for a bigger bump, and never write those tokens in a message that is only describing them.

## Hard constraints (never relax these)

- Manifest V3, strict TypeScript, no `any` without a comment justifying it.
- No remote code, no CDN scripts, no telemetry, no sending URLs or browsing data to any server.
- Never bypass DRM, authentication, paywalls, or site security. Protected content (Widevine, PlayReady, FairPlay,
  SAMPLE-AES, EME-protected playback) is flagged and refused for downloads, captures **and** recordings. Streams whose
  key is openly delivered (AES-128 HLS, ClearKey) are allowed and labelled as such. No site-specific extractors.
- Request the minimum permissions; broad host access is optional and user-initiated only. All-sites access ("allow all
  embedded players") is asked for only on the user's click, once, and is revocable. The page hook (MAIN-world script,
  `Look inside players`) is on by default but registered only for sites the user allowed and only while enabled; it is
  read-only and sends nothing anywhere.
  Header replay is limited to the Referer/Origin the browser itself sent for that frame, for one job.
- Validate URL schemes: the extension itself fetches **http/https only**. `blob:` and `data:` bytes are read only inside
  the page that owns them (the content script of that frame) and travel over the acknowledged ingest port; the
  extension never fetches a `blob:` URL. Sanitise filenames, never `dangerouslySetInnerHTML`, never log URLs with
  credentials/tokens.
- No simulated progress, no mock data outside tests or an explicitly labelled dev fixture.
- Every user-visible string goes through the i18n helper (`en` and `it` catalogs must stay in sync).

### Desktop app exceptions (`desktop/`, design in `docs/desktop.md`)

The rules above hold for the app too (DRM refused with the shared `vdh-core` verdicts, no extractors, no telemetry,
sanitised filenames, no simulated progress, en/it), with these agreed exceptions:

- The app **may re-encode video**, only when the user picks a re-encode option. The extension never does.
- The **update check** (GitHub Releases, no identifiers, no browsing data, toggle in Settings, install only after the
  user confirms) is the one network call that is not media the user chose.
- The extension may pass **cookies of origins the user granted, for one job**; the app keeps them in memory only and
  never writes or logs them.
- The app fetches any http(s) address a job names, local network included (the extension keeps its own guard).
- ffmpeg runs as a separate process with argument vectors built by `vdh-core`, never through a shell.

## Commands

```bash
npm run build          # production build into dist/ (also copies the FFmpeg.wasm core)
npm run check:dist     # manifest / assets / locales / CSP / no-remote-code checks on dist/
npm run typecheck      # strict tsc
npm run lint           # eslint (no any, no dangerouslySetInnerHTML, no eval)
npm run format:check   # prettier
npm test               # vitest (unit)
npm run test:e2e       # real Chromium + fixtures; needs ffmpeg/ffprobe on PATH
npm run serve:fixtures # the E2E sites, for manual testing
node scripts/backlog.mjs set VDH-0xx done   # update a task status + the BACKLOG index
cargo fmt --check && cargo clippy --workspace -- -D warnings && cargo test --workspace   # Rust core / desktop
```

## Layout

`src/background` (service worker) · `src/content` (read-only scanner) · `src/offscreen` (segments + FFmpeg.wasm) ·
`src/popup` / `src/options` / `src/sidepanel` (React UIs) · `src/lib` (pure logic, the unit-tested core) ·
`e2e/` (Playwright) · `core/` (Rust shared core) · `desktop/` (Tauri app) · `docs/` (incl. `store-policy.md`,
`desktop.md`) · `BACKLOG/`. See README for the architecture and the
verification limits.

## Things that are easy to get wrong

- `chrome.downloads.open()` needs a user gesture: call it from the page that got the click, never from the service worker.
- Never sniff or log full URLs (`log` in `lib/security.ts` redacts them); never render page-derived text as HTML.
- Video is never re-encoded. Audio may be. `lib/compat.ts` is the single source of truth for what is allowed; the UI
  and the background both use it, and the background re-validates every request.
- Cookies go only to origins the user granted (`credentialedOrigins`); everything else is fetched with `credentials: 'omit'`.
- A request names a resource; the background re-derives URLs, frames, held bytes, ZIP contents and what may be captured
  or recorded from **its own scan**. Never trust `held`, `replay`, `zip.items`, `capture`, `record` or `liveRecord` from a
  message beyond the validated shape (`sanitizeRequest`, then the checks in `runner.ts`).
- Chrome refuses to load a script that contains a Unicode noncharacter (e.g. a literal U+FFFF in a regex) with the
  misleading "isn't UTF-8 encoded": write such characters as escapes (`check:dist` fails the build otherwise).
- Test-only tools (hls.js, dash.js, Playwright) are devDependencies and must never reach `dist/` (`check:dist` asserts it).
- Do not mark a backlog task `done` for something that was only unit-tested if it also needs a real browser.
