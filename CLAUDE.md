# vdown-helper

> Detect. Decode. Download. — YOUR MEDIA. YOUR CONTROL.

Chrome Manifest V3 extension (TypeScript, React, Vite, Tailwind) that detects videos on a page
(direct files, HLS) and downloads them locally with an optional FFmpeg.wasm pipeline.

## Working agreement

- **All work is tracked in `BACKLOG/`.** Read `.claude/rules/backlog.md` before starting any task.
- Develop on the branch named in the session instructions; commit per backlog stage with the task
  ID in the subject (`VDH-005: HLS parser`). Do not open a PR unless asked.

## Hard constraints (never relax these)

- Manifest V3, strict TypeScript, no `any` without a comment justifying it.
- No remote code, no CDN scripts, no telemetry, no sending URLs or browsing data to any server.
- Never bypass DRM, authentication, paywalls, or site security. Protected content is flagged, not downloaded.
- Request the minimum permissions; broad host access is optional and user-initiated only.
- Validate URL schemes (http/https/blob only), sanitise filenames, never `dangerouslySetInnerHTML`,
  never log URLs with credentials/tokens.
- No simulated progress, no mock data outside tests or an explicitly labelled dev fixture.
- Every user-visible string goes through the i18n helper (`en` and `it` catalogs must stay in sync).

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
```

## Layout

`src/background` (service worker) · `src/content` (read-only scanner) · `src/offscreen` (segments + FFmpeg.wasm) ·
`src/popup` / `src/options` / `src/sidepanel` (React UIs) · `src/lib` (pure logic, the unit-tested core) ·
`e2e/` (Playwright) · `docs/` · `BACKLOG/`. See README for the architecture and the verification limits.

## Things that are easy to get wrong

- `chrome.downloads.open()` needs a user gesture: call it from the page that got the click, never from the service worker.
- Never sniff or log full URLs (`log` in `lib/security.ts` redacts them); never render page-derived text as HTML.
- Video is never re-encoded. Audio may be. `lib/compat.ts` is the single source of truth for what is allowed; the UI
  and the background both use it, and the background re-validates every request.
- Cookies go only to origins the user granted (`credentialedOrigins`); everything else is fetched with `credentials: 'omit'`.
- Do not mark a backlog task `done` for something that was only unit-tested if it also needs a real browser.
