---
id: VDH-038
title: Blob files and MSE capture
status: in-progress
priority: P0
area: content
depends_on: [VDH-033]
---

# VDH-038: Blob files and MSE capture

## Description

Read real Blob sources from the page. For MSE players, first discover the real manifest via the hook; when none exists, record what the player appends (fast capture with a visible banner, or real-time), mux it and save. EME/protected playback is refused.

## Acceptance criteria

- [x] Real Blob URLs download correctly (E2E: typed and untyped blobs, a 9 MiB blob over several chunks, a URL revoked after listing)
- [ ] hls.js and dash.js players inside iframes are resolved through manifest discovery
- [ ] Recording fallback produces a decodable file (fast and real-time)
- [ ] A visible, cancellable banner shows while the page is manipulated, and playback state is restored
- [ ] EME-protected video is refused and never recorded
- [ ] A resolution switch during capture yields parts, never a re-encode

## Notes

### Stage 1 (done): real blob files

- The synchronous scan still never reports `blob:` sources; `scanAsync()` reads each one with `fetch(blobUrl)` (2.5 s limit), keeps the **Blob object**
  (so a page that revokes the URL afterwards cannot take the data away from a download already offered), recognises untyped blobs from their first
  bytes (`lib/sniff.ts`; Chrome answers fetch() of an untyped Blob with `text/plain`, which is not trusted) and lists the result like any file/image/
  document/archive/asset with its real size. What cannot be read (MediaSource URLs, URLs revoked before the scan, unknown content) stays counted in
  `notes.blobSources`.
- Bytes travel over the same acknowledged port as `data:` (VDH-036), now in 4 MiB chunks and streamed from the Blob; a blob is capped at 4 GiB (a `data:` URL at
  32 MB); FFmpeg conversions are still bounded by the memory limit.

### Stage 2 (in progress): MSE capture

- Pure building blocks exist and are unit-tested: `lib/mse.ts` (fragmented-MP4 and WebM init/segment parsing, never throws), `lib/mseParts.ts` (chunk
  classification, de-duplication, splitting into parts at a video init change, audio placed by time window).
- Still to do: hook recorder + relay, capture controller with banner, multi-track ingest, parts assembly + FFmpeg copy, UI, E2E with real MSE playback,
  EME refusal.
