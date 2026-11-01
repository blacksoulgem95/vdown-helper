---
id: VDH-084
title: Endless script streams (live.php): record until Stop instead of a download that never ends
status: todo
priority: P2
area: background
depends_on: [VDH-083]
---

# VDH-084: Endless script streams (live.php): record until Stop instead of a download that never ends

## Description

A script that streams a live video without end (`live.php`, a `<video>` whose `duration` is `Infinity`) is listed as an
ordinary file: DOWNLOAD starts a Chrome download that never finishes, and cancelling it keeps nothing. Offer what live
HLS/DASH already get: record from now until Stop (fetched by the extension, keeping what arrived), with the size so far.

## Acceptance criteria

- [ ] The scanner passes `duration === Infinity` as a live hint; such a stream is listed as live
- [ ] Recording until Stop keeps a playable file (fragmented MP4 / WebM checked with ffprobe)
- [ ] E2E with an endless fixture
- [ ] CI green on the PR head

## Notes

- Found while reproducing VDH-083 (case f).
