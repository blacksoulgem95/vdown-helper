# Backlog

Tasks for vdown-helper. The rules for maintaining this folder are in `.claude/rules/backlog.md`.

## Status legend

| Status | Meaning |
|---|---|
| `todo` | Not started |
| `in-progress` | Being worked on |
| `blocked` | Cannot proceed (reason in task notes) |
| `done` | Acceptance criteria met and verified |
| `wontfix` | Deliberately dropped |

Priorities: P0 critical, P1 high, P2 normal, P3 low.

## Index

| ID | Title | Status | Priority | Area | Depends on |
|---|---|---|---|---|---|
| [VDH-001](VDH-001-project-scaffold.md) | Project scaffold | todo | P0 | build | - |
| [VDH-002](VDH-002-manifest-permissions-csp.md) | MV3 manifest, permissions model, CSP | todo | P0 | build | VDH-001 |
| [VDH-003](VDH-003-types-and-messaging.md) | Shared types and typed messaging | todo | P0 | lib | VDH-001 |
| [VDH-004](VDH-004-security-utils.md) | Security utilities | todo | P0 | security | VDH-001 |
| [VDH-005](VDH-005-hls-parser.md) | HLS playlist parser | todo | P0 | lib | VDH-004 |
| [VDH-006](VDH-006-metadata-dedupe.md) | Media metadata and dedupe utilities | todo | P1 | lib | VDH-003, VDH-004 |
| [VDH-007](VDH-007-content-scanner.md) | Content-script DOM and performance scanner | todo | P0 | content | VDH-003, VDH-006 |
| [VDH-008](VDH-008-background-detection.md) | Background detection and per-tab store | todo | P0 | background | VDH-005, VDH-007 |
| [VDH-009](VDH-009-download-queue.md) | Download queue and state machine | todo | P0 | background | VDH-003 |
| [VDH-010](VDH-010-direct-downloads.md) | Direct file downloads via chrome.downloads | todo | P0 | background | VDH-009 |
| [VDH-011](VDH-011-hls-segment-downloader.md) | HLS segment downloader (offscreen document) | todo | P0 | background | VDH-005, VDH-009 |
| [VDH-012](VDH-012-ffmpeg-wasm-pipeline.md) | FFmpeg.wasm processing pipeline | todo | P1 | background | VDH-011 |
| [VDH-013](VDH-013-design-system.md) | Design system and theme | todo | P1 | ui | VDH-001 |
| [VDH-014](VDH-014-popup-ui.md) | Popup UI | todo | P0 | ui | VDH-008, VDH-009, VDH-013 |
| [VDH-015](VDH-015-studio-side-panel.md) | Studio configure screen (side panel) | todo | P0 | ui | VDH-012, VDH-014 |
| [VDH-016](VDH-016-options-and-settings.md) | Options page and settings persistence | todo | P1 | ui | VDH-003, VDH-013 |
| [VDH-017](VDH-017-unit-tests.md) | Unit test suite | todo | P0 | test | VDH-005, VDH-006, VDH-009 |
| [VDH-018](VDH-018-e2e-playwright.md) | Browser E2E in real Chromium | todo | P0 | test | VDH-014, VDH-015, VDH-016 |
| [VDH-019](VDH-019-readme-docs.md) | README and documentation | todo | P1 | docs | VDH-018 |
| [VDH-020](VDH-020-native-companion-doc.md) | Native companion architecture doc | todo | P3 | docs | VDH-019 |
| [VDH-021](VDH-021-i18n-en-it.md) | Internationalisation (en, it) | todo | P1 | ui | VDH-003 |
| [VDH-022](VDH-022-ci-and-tooling.md) | CI workflow and lint/format tooling | todo | P2 | build | VDH-001 |
| [VDH-023](VDH-023-branding-icons.md) | Logo and icons | todo | P2 | ui | VDH-001 |
| [VDH-024](VDH-024-license-notices.md) | License and third-party notices | todo | P2 | docs | VDH-012 |
