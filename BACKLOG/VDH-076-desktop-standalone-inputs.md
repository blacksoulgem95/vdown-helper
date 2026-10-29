---
id: VDH-076
title: Desktop app: page scan, local files, clipboard watch, folder rules
status: todo
priority: P2
area: desktop
depends_on: [VDH-066]
---

# VDH-076: Desktop app: page scan, local files, clipboard watch, folder rules

## Description

The standalone inputs split out of VDH-066:

- Page scan: fetch a page's HTML once and list `<video>`/`<source>`, `.m3u8`/`.mpd`/media links and `og:video`, with
  `vdh-core`'s sniffing and file types. No scripts, no iframes followed, no site extractors.
- Local files: drop or pick files to remux (no re-encode here, that is VDH-068).
- Clipboard watch (off by default): offer media addresses copied while the app runs.
- Folder rules: templates such as `{type}/{host}/{title}` under the download folder, sanitised.

## Acceptance criteria

- [ ] Page scan of the fixture pages lists their media; protected items are marked and refused
- [ ] Local file remux (MP4/MKV/TS) checked with ffprobe and a full decode
- [ ] Clipboard watch, off by default, never reads the clipboard while off
- [ ] Folder rules with sanitised names; tests for the templates
- [ ] Linux E2E of the real app covers the scan and a local remux
- [ ] CI green on the PR head

## Notes

- Split from VDH-066 so each PR stays reviewable.
