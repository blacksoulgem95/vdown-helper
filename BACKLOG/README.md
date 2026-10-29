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
| [VDH-001](VDH-001-project-scaffold.md) | Project scaffold | done | P0 | build | - |
| [VDH-002](VDH-002-manifest-permissions-csp.md) | MV3 manifest, permissions model, CSP | done | P0 | build | VDH-001 |
| [VDH-003](VDH-003-types-and-messaging.md) | Shared types and typed messaging | done | P0 | lib | VDH-001 |
| [VDH-004](VDH-004-security-utils.md) | Security utilities | done | P0 | security | VDH-001 |
| [VDH-005](VDH-005-hls-parser.md) | HLS playlist parser | done | P0 | lib | VDH-004 |
| [VDH-006](VDH-006-metadata-dedupe.md) | Media metadata and dedupe utilities | done | P1 | lib | VDH-003, VDH-004 |
| [VDH-007](VDH-007-content-scanner.md) | Content-script DOM and performance scanner | done | P0 | content | VDH-003, VDH-006 |
| [VDH-008](VDH-008-background-detection.md) | Background detection and per-tab store | done | P0 | background | VDH-005, VDH-007 |
| [VDH-009](VDH-009-download-queue.md) | Download queue and state machine | done | P0 | background | VDH-003 |
| [VDH-010](VDH-010-direct-downloads.md) | Direct file downloads via chrome.downloads | done | P0 | background | VDH-009 |
| [VDH-011](VDH-011-hls-segment-downloader.md) | HLS segment downloader (offscreen document) | done | P0 | background | VDH-005, VDH-009 |
| [VDH-012](VDH-012-ffmpeg-wasm-pipeline.md) | FFmpeg.wasm processing pipeline | done | P1 | background | VDH-011 |
| [VDH-013](VDH-013-design-system.md) | Design system and theme | done | P1 | ui | VDH-001 |
| [VDH-014](VDH-014-popup-ui.md) | Popup UI | done | P0 | ui | VDH-008, VDH-009, VDH-013 |
| [VDH-015](VDH-015-studio-side-panel.md) | Studio configure screen (side panel) | done | P0 | ui | VDH-012, VDH-014 |
| [VDH-016](VDH-016-options-and-settings.md) | Options page and settings persistence | in-progress | P1 | ui | VDH-003, VDH-013 |
| [VDH-017](VDH-017-unit-tests.md) | Unit test suite | done | P0 | test | VDH-005, VDH-006, VDH-009 |
| [VDH-018](VDH-018-e2e-playwright.md) | Browser E2E in real Chromium | done | P0 | test | VDH-014, VDH-015, VDH-016 |
| [VDH-019](VDH-019-readme-docs.md) | README and documentation | done | P1 | docs | VDH-018 |
| [VDH-020](VDH-020-native-companion-doc.md) | Native companion architecture doc | done | P3 | docs | VDH-019 |
| [VDH-021](VDH-021-i18n-en-it.md) | Internationalisation (en, it) | done | P1 | ui | VDH-003 |
| [VDH-022](VDH-022-ci-and-tooling.md) | CI workflow and lint/format tooling | done | P2 | build | VDH-001 |
| [VDH-023](VDH-023-branding-icons.md) | Logo and icons | done | P2 | ui | VDH-001 |
| [VDH-024](VDH-024-license-notices.md) | License and third-party notices | done | P2 | docs | VDH-012 |
| [VDH-025](VDH-025-open-file-needs-gesture.md) | Open / show downloaded file needs a user gesture | done | P1 | ui | VDH-014 |
| [VDH-026](VDH-026-popup-premature-ready.md) | Popup showed READY before its first scan | done | P2 | ui | VDH-014 |
| [VDH-027](VDH-027-publish-branch.md) | Publish the branch to GitHub | done | P0 | build | - |
| [VDH-028](VDH-028-manual-chrome-verification.md) | Manual verification in branded Google Chrome | todo | P1 | test | VDH-018 |
| [VDH-029](VDH-029-credential-and-ssrf-hardening.md) | Cookies and extension fetches limited to what the user chose | done | P0 | security | VDH-008, VDH-011 |
| [VDH-030](VDH-030-resource-limits-hostile-servers.md) | Byte, time and count limits against hostile servers and playlists | done | P1 | security | VDH-011 |
| [VDH-031](VDH-031-hls-correctness-fixes.md) | HLS correctness: encrypted init sections, ignored Range, unusable keys | done | P1 | lib | VDH-011 |
| [VDH-032](VDH-032-release-pipeline.md) | Release pipeline for main (Chrome package + tag + GitHub Release) | in-progress | P1 | build | VDH-022, VDH-002 |
| [VDH-033](VDH-033-frames-hook-foundation.md) | All-frame scanning, opt-in page hook, header replay | done | P0 | content | VDH-008 |
| [VDH-034](VDH-034-dash-support.md) | MPEG-DASH support | done | P0 | lib | VDH-033 |
| [VDH-035](VDH-035-subtitles.md) | Subtitles and captions | done | P1 | lib | VDH-034 |
| [VDH-036](VDH-036-more-formats-data-urls.md) | More container/audio formats and data: URLs | done | P1 | lib | VDH-033 |
| [VDH-037](VDH-037-file-types-tabs-zip.md) | Images, documents, archives and page assets with ZIP download | done | P1 | ui | VDH-033 |
| [VDH-038](VDH-038-blob-mse-capture.md) | Blob files and MSE capture | done | P0 | content | VDH-033 |
| [VDH-039](VDH-039-mediastream-recording.md) | MediaStream recording | done | P1 | content | VDH-038 |
| [VDH-040](VDH-040-live-recording.md) | Live and event stream recording | done | P1 | background | VDH-034 |
| [VDH-041](VDH-041-open-site-metadata.md) | Metadata and open-site recognition | done | P2 | lib | VDH-033 |
| [VDH-042](VDH-042-tabbed-popup.md) | Tabbed popup with frame grouping | done | P1 | ui | VDH-037 |
| [VDH-043](VDH-043-test-players-fixtures.md) | Realistic test players and fixtures | done | P1 | test | VDH-033 |
| [VDH-044](VDH-044-docs-store-policy.md) | Docs, store policy and constraints update | in-progress | P1 | docs | VDH-043 |
| [VDH-045](VDH-045-clearkey-cenc.md) | ClearKey / CENC decryption for DASH | todo | P3 | lib | VDH-034 |
| [VDH-046](VDH-046-verify-site-adapters.md) | Verify the open-site adapters against the real services | todo | P3 | test | VDH-041 |
| [VDH-047](VDH-047-security-review-fixes.md) | Fixes from the independent security review | done | P0 | security | VDH-044 |
| [VDH-048](VDH-048-ci-green-and-pr-flow.md) | CI green on GitHub, release bump rule, PR-and-merge flow | done | P0 | build | VDH-022, VDH-032, VDH-047 |
| [VDH-049](VDH-049-hook-default-and-all-embedded.md) | Page hook on by default, one grant for all embedded players | done | P1 | security | VDH-033 |
| [VDH-050](VDH-050-popup-funnel.md) | Popup funnel - from opening the popup to the right download in one click | done | P1 | ui | VDH-049 |
| [VDH-051](VDH-051-mse-player-fix-action.md) | MediaSource players say what is missing and offer the one fix | done | P1 | ui | VDH-049 |
| [VDH-052](VDH-052-site-and-store-assets.md) | GitHub Pages site and Chrome Web Store images (en + it) | done | P1 | docs | VDH-050, VDH-044 |
| [VDH-053](VDH-053-observer-misses-requests.md) | Network observer missed requests (sleeping worker, lost writes) | done | P0 | background | VDH-012 |
| [VDH-054](VDH-054-paste-stream-link.md) | Add a stream link by hand (.m3u8, .m3u, .mpd, media files) | done | P1 | ui | VDH-050 |
| [VDH-055](VDH-055-ts-saved-as-txt.md) | Streams saved as .txt on Linux (untyped staged file) | done | P0 | offscreen | VDH-047 |
| [VDH-056](VDH-056-frame-note-and-colon-names.md) | No false "frames could not be inspected" note; colons in titles become " - " in file names | done | P2 | ui | VDH-033 |
| [VDH-057](VDH-057-settings-flash-defaults.md) | Settings page showed the defaults until the stored settings loaded | done | P2 | ui | VDH-010 |
| [VDH-058](VDH-058-frames-wipe-and-scan-hang.md) | A loading frame wiped the page's results; a frame that never finishes loading hung the scan | done | P0 | background | VDH-033 |
| [VDH-059](VDH-059-mp4-by-default-warn-on-size.md) | Streams saved as MP4 by default; size only warns, never blocks | done | P1 | lib | VDH-050 |
| [VDH-060](VDH-060-e2e-after-mp4-default.md) | E2E follows the MP4 default and waits for the navigation clear | done | P0 | test | VDH-058, VDH-059 |
| [VDH-061](VDH-061-desktop-groundwork.md) | Desktop app groundwork: rules, design doc, pinned extension ID, Rust workspace and CI | done | P1 | build | VDH-020 |
| [VDH-062](VDH-062-core-wasm-parsers.md) | Rust core compiled to wasm: loader in every extension context; HLS, DASH, XML, DRM verdicts, inspection | done | P1 | lib | VDH-061 |
| [VDH-063](VDH-063-core-wasm-planner.md) | Rust core: planner, ffmpeg arguments, requests, settings, security, file types, sniffing | done | P1 | lib | VDH-062, VDH-071 |
| [VDH-064](VDH-064-core-wasm-rest.md) | Rust core: the remaining pure modules | done | P2 | lib | VDH-063 |
| [VDH-065](VDH-065-desktop-engine.md) | Desktop engine and CLI: fetching, HLS/DASH/AES-128, live recording, native ffmpeg | done | P1 | desktop | VDH-063 |
| [VDH-066](VDH-066-desktop-app-standalone.md) | Desktop app (Tauri v2): window, queue, history, settings, tray | done | P1 | desktop | VDH-065, VDH-075 |
| [VDH-067](VDH-067-native-link.md) | Native link: extension hands jobs to the desktop app | done | P1 | desktop | VDH-066 |
| [VDH-068](VDH-068-desktop-reencode.md) | Desktop re-encoding: presets, codec controls, trim, MKV, soft subtitles, batch | todo | P2 | desktop | VDH-066 |
| [VDH-069](VDH-069-desktop-packaging.md) | Desktop packaging, updater and release workflow | todo | P1 | build | VDH-066 |
| [VDH-070](VDH-070-owner-extension-key.md) | Pin the extension ID with the owner's public key | done | P1 | build | VDH-061 |
| [VDH-071](VDH-071-page-scanner-without-core.md) | The page scanner never loads the shared core (content.js back to ~20 KB) | done | P0 | content | VDH-062 |
| [VDH-072](VDH-072-wasm-size.md) | Trim the shared core's wasm (about 1 MB, inlined in every extension page) | todo | P2 | build | VDH-063 |
| [VDH-073](VDH-073-e2e-recording-wait.md) | E2E: closing the tab while recording waits for relayed chunks, not a fixed sleep | done | P2 | test | - |
| [VDH-074](VDH-074-core-wasm-analyze.md) | Rust core: candidate analysis (analyze, classify) | todo | P2 | lib | VDH-064 |
| [VDH-075](VDH-075-desktop-queue.md) | Desktop engine: persistent queue, resume after restart, bandwidth cap, schedule, history | done | P1 | desktop | VDH-065 |
| [VDH-076](VDH-076-desktop-standalone-inputs.md) | Desktop app: page scan, local files, clipboard watch, folder rules | todo | P2 | desktop | VDH-066 |
| [VDH-077](VDH-077-desktop-push-captures.md) | Desktop link: hand MSE captures and recordings to the app (push-bytes) | todo | P2 | desktop | VDH-067, VDH-068 |
| [VDH-078](VDH-078-ci-live-probe-hang.md) | CI: the app E2E's live probe sometimes never answers | todo | P2 | test | VDH-067 |
