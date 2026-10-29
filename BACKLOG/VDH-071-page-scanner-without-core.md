---
id: VDH-071
title: The page scanner never loads the shared core (content.js back to ~20 KB)
status: done
priority: P0
area: content
depends_on: [VDH-062]
---

# VDH-071: The page scanner never loads the shared core

## Description

VDH-062 made `lib/xml` and `lib/dash` wasm-backed. The page scanner reached them through `lib/metadata`, so the whole
core (~760 KB) was inlined in `content.js` and compiled in every frame of every scanned page (content.js went from 39 KB
to 763 KB). The owner chose that page scripts classify nothing: they report raw facts and the background decides.

## Acceptance criteria

- [x] The scanner reports raw facts: `<a href>` links and Performance entries as hints, page-held blobs with their
      declared type and (when it says nothing) their first bytes, and the page's metadata as found (tags, links, JSON-LD)
- [x] The background classifies them (`lib/classify`: documents/archives among links, files among resources, what a
      blob is, unreadable blobs counted back) and parses the metadata, feeds and open-site APIs (`background/pageData`);
      feeds and site APIs are still read by the frame itself, anonymously and only from its own origin
- [x] Content scripts log only fixed words (`content/log.ts`), never page-derived text
- [x] `check:dist` fails if `content.js` or `hook.js` carries the core; content.js is ~20 KB
- [x] The scanner unit tests keep their expectations through scanner + classifier; full E2E green

## Notes

- A blob the page can read but whose bytes are not recognised is now dropped by the background (and counted as
  unreadable) even when a media element plays it; before, the page offered it for MediaSource capture. Real MediaSource
  URLs cannot be read by the page, so they still take the capture path.
- Verified: local suite (E2E 113/113, content.js 21.5 KB) on b3bb952; CI on PR #13 green: CI runs 40789269397 and 40789296552 (check, e2e), Desktop runs 40789269367 and 40789296461.
