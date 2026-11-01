---
id: VDH-083
title: Script-served media (stream.php?id=…): sniff the first bytes, Content-Disposition, typed links, names
status: in-progress
priority: P1
area: lib
depends_on: [VDH-082]
---

# VDH-083: Script-served media (stream.php?id=…): sniff the first bytes, Content-Disposition, typed links, names

## Description

An address of a script that streams a video (`video.php?id=12`, `/stream/42`, `.aspx`) is found when a `<video>` plays
it and its HEAD names a media type, but not otherwise (reproduced in real Chromium with an emulated script, owner's
report):

- a plain link to it is never listed, even when the page marks it `type="video/mp4"` or `download="clip.mp4"`;
- a HEAD that answers `text/html` (PHP's default) makes a link or a pasted address **unsupported**, although GET sends
  `video/mp4`;
- when the type stays unknown (`text/html`, `application/octet-stream` with a `Content-Disposition` name, or headers
  unreadable across origins) the file is saved without an extension;
- a video in a same-origin iframe is listed as audio (`instanceof` across documents).

## Acceptance criteria

- [ ] When the declared type is vague, the first bytes are read (capped ranged GET, endless streams included) and the
      type a GET declares, the magic numbers (MP4/WebM/…, `#EXTM3U`, `<MPD`) or the `Content-Disposition` name decide
- [ ] Links the page marks as media (`type="video/…"`, `download="….mp4"`) are listed; other links to scripts are never
      requested
- [ ] A Chrome download of a file whose type is still unknown is named by Chrome (type / `Content-Disposition`)
      instead of saved without an extension
- [ ] Videos in same-origin iframes are videos
- [ ] Unit tests, and an E2E step with a script that answers HEAD with text/html and one with octet-stream +
      Content-Disposition (listed as MP4, downloaded and checked with ffprobe; a logout link never requested)
- [ ] CI green on the PR head

## Notes

- Reproduction and root causes: a real-Chromium run with an emulated PHP script (cases: correct type, HEAD 405,
  HEAD text/html, octet-stream + Content-Disposition, no extension, endless stream) and page usages (`<video>`,
  `<source>`, JS `src`, iframe, direct, links, pasted, page `fetch()`).
- Not covered here: a page `fetch()` of an octet-stream file (the page hook and the network observer still need a media
  type or extension); a link with an empty `download` attribute; endless streams (VDH-084).
