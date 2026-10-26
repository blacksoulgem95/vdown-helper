---
id: VDH-035
title: Subtitles and captions
status: done
priority: P1
area: lib
depends_on: [VDH-034]
---

# VDH-035: Subtitles and captions

## Description

Detect WebVTT/SRT/TTML tracks from <track>, HLS subtitle renditions (segmented VTT stitched into one file) and DASH text sets; save as found; offer SRT conversion.

## Acceptance criteria

- [x] Subtitle resources appear in their own tab (popup tab strip when a page has both media and subtitles; Studio has a dedicated subtitle form)
- [x] Segmented HLS VTT is stitched with correct timestamps (X-TIMESTAMP-MAP) (unit + E2E: two segments placed at 1 s and 6.5 s)
- [x] WebVTT and TTML convert to valid SRT (unit tests; E2E checks the exact files for VTT, SRT and TTML input)
- [x] Saved files are verified (E2E): a WebVTT track is byte-identical to the original; converted files are compared exactly

## Notes

- Sources: `<track kind=subtitles|captions>` (WebVTT per the HTML spec), `.vtt/.srt/.ttml/.dfxp` links and requests, HLS `EXT-X-MEDIA TYPE=SUBTITLES`
  renditions (and a bare WebVTT playlist), DASH text representations.
- Output: "as found" (a plain document is a native Chrome download, byte-for-byte; stitched streams are written as WebVTT) or SRT.
  Conversion keeps text and timing and drops styling/positioning. Unknown formats can only be saved converted.
- Segments of a subtitle playlist are never listed on their own (`covered` set in `lib/analyze.ts`).
- Fixed on the way: `resourceId` now keeps the DASH representation fragment, so the tracks of one manifest are not merged with
  the manifest or each other; the XML reader keeps document order (`XmlNode.content`) so TTML `<br/>` and mixed text are right.
- Subtitle tracks of an encrypted DASH stream are offered (they are separate clear text); the media itself stays refused.
- **Not supported, said honestly in the UI** (`subtitle-unsupported`): WebVTT-in-MP4 (`wvtt`) cues and image/bitmap subtitles.
- **Verified only with hand-built fixtures**: the IMSC1 (`stpp`) MP4 segments in the E2E are a minimal `moof`+`mdat` written by the test;
  segments from a real packager (other box layouts, several samples per mdat) are covered only by unit tests of the box walker.
  Real-site subtitle packaging is listed in VDH-028.
