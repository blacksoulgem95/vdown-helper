---
id: VDH-037
title: Images, documents, archives and page assets with ZIP download
status: done
priority: P1
area: ui
depends_on: [VDH-033]
---

# VDH-037: Images, documents, archives and page assets with ZIP download

## Description

Detect images (img, picture, CSS backgrounds, og:image), documents, archives and page assets; show them in their own tabs with counts, size filters and per-type caps; download one, selected, or all as ZIP (bounded by the memory limit).

## Acceptance criteria

- [x] Each type has its own tab with a count and caps
- [x] Image minimum-size filter works
- [x] ZIP contains the selected files with collision-free names; above the limit it splits or refuses with an explanation
- [x] E2E: image, PDF, archive and asset downloads, plus a ZIP

## Notes

- Sources (all read-only, bounded): `<img>` (with natural size), `video[poster]`, `link[rel~=icon]`/`apple-touch-icon`, `og:image`/`twitter:image`,
  CSS `background-image` through computed style (first 1,500 elements), document/archive links, `<script src>`, stylesheets, preloaded fonts,
  and Resource Timing entries (which also carry the transfer size). `data:` images of at least 2 KB come through the page-held channel (VDH-036).
- Caps per scan, per kind (so images cannot crowd out media): media 60 analysed / 200 reported, images 300, documents 100, archives 100, assets 200.
  At most 150 HEAD requests per scan; the rest are listed from what the page already knew and downloaded as they are.
- Names are the server's own (decoded stem + extension from URL or MIME). Single files are Chrome's native download (a hotlink-protected one
  falls back to the extension's fetch with the frame's Referer, as before).
- ZIP: the request only names resources; the **background derives every URL and entry name from its own scan** (`submitZip`), so a request cannot
  make the extension fetch anything the page did not show. Classic ZIP written to disk as it grows (fflate, now a shipped dependency, MIT, in
  THIRD_PARTY_NOTICES); text-like files are deflated, everything else stored. One file is held in memory at a time (≤ 256 MB); a file that fails or
  no longer fits is **skipped and named in `_not-saved.txt`** (no URLs) and the job reports how many. The limit is the memory-limit setting capped at 4 GB
  (no ZIP64): over it up front the ZIP is refused with an explanation; while writing, nothing is allowed past it. Entry names are flat, sanitised and
  unique case-insensitively (`photo.jpg`, `photo (2).jpg`). Page-held (`data:`) images are not put in ZIPs (counted as left out).
- Cookies go to the page's origin and the frames' origins only; the Referer is replayed only when every file came from one frame.
- Splitting an over-limit selection into several archives is **not** implemented: it is refused instead.
