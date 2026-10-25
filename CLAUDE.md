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

Filled in as the scaffold lands (see `BACKLOG/VDH-001-project-scaffold.md`): `npm run build`,
`npm test`, `npm run typecheck`, `npm run lint`, `npm run test:e2e`.
