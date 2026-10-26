---
id: VDH-036
title: More container/audio formats and data: URLs
status: done
priority: P1
area: lib
depends_on: [VDH-033]
---

# VDH-036: More container/audio formats and data: URLs

## Description

Add FLV, AVI, WMV, 3GP, MPG, ASF, AIFF, WMA, Opus and friends to detection, naming and container-compatibility rules (copy only, never re-encode video). Decode data: media sources inside the page and hand them to the pipeline.

## Acceptance criteria

- [x] New formats detected by URL and MIME with correct extensions
- [x] Remux rules refuse combinations that would need video re-encoding
- [x] data: media is saved correctly and size-capped; data: is never fetched by the extension
- [x] Unit tests and an E2E data: download

## Notes

- Formats: `flv avi wmv asf 3gp(3g2) mpg(mpeg,mpe) aiff(aif,aifc) wma opus` (`.opus` is now its own format, not "ogg").
  Saved as found (native download) with the right extension. Verified in a real browser with files made from codecs typical
  of each format (FLV h264/AAC, AVI MPEG-4/MP3, WMV/ASF WMV2/WMA2, 3GP h264/AAC, MPG MPEG-2/MP2, AIFF PCM, WMA, Opus).
- Remux is **by format**, because the codecs inside a direct file are not known up front: FLV → MP4/MKV(/TS), 3GP → MP4/MKV,
  MPG → MKV(/TS), AVI/WMV/ASF → MKV only. Everything else is refused as `video-codec-container` (never re-encoded). A file that
  deviates (e.g. an FLV with Sorenson H.263) would still fail inside FFmpeg with a clear error rather than be converted.
  The Studio offers MP4 and MKV for plain files (TS stays HLS-only).
- FFmpeg runs with `-fflags +genpts`: MPEG-PS copies into Matroska failed without it ("timestamps are unset").
- AIFF/WMA/Opus → MP3 works in the bundled FFmpeg.wasm core (verified); so do FLV→MP4 and AVI/WMV/MPG→MKV copies, all decodable.
- **Bug found and fixed on the way**: a plain audio file (mp3, m4a, wav …) with the default settings was refused as "no video
  source". "Original" now means "keep an audio file as it is" (and joins an audio-only HLS rendition without FFmpeg).
- data: URLs: the scanner reports `data:<type>;vdh=<handle>` (a label with **no payload**) plus the decoded size; the data stays
  in the page. On download the background (which only accepts labels matching its own scan) tells the owning frame to send the
  bytes to the offscreen document over a `chrome.runtime` port in acknowledged base64 chunks (`src/content/ingest.ts`,
  `src/offscreen/ingest.ts`, protocol in `src/types/ingest.ts`). The offscreen side accepts only this extension's content
  script, from the job's tab and frame, once, with a hard size cap (32 MB), ordered chunks and a 20 s connect timeout.
  The extension never fetches a `data:` URL; nothing but the label is stored. Media types video/* and audio/* only.
- Not done on purpose: data: images/documents (VDH-037 reuses this channel), data: subtitles, data: media above 32 MB (reported as
  too large). `blob:` files reuse the same channel in VDH-038.
