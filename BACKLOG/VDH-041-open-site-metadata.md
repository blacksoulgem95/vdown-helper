---
id: VDH-041
title: Metadata and open-site recognition
status: done
priority: P2
area: lib
depends_on: [VDH-033]
---

# VDH-041: Metadata and open-site recognition

## Description

Recognise media through public, standard metadata (Open Graph, JSON-LD VideoObject, link rel=alternate, oEmbed, RSS enclosures) and public APIs of Wikimedia Commons, Internet Archive and PeerTube. No private APIs, no logins, no per-site scraping of any streaming site.

## Acceptance criteria

- [x] Metadata parsers unit-tested with samples (Open Graph/Twitter tags, JSON-LD incl. @graph, alternate links, RSS and Atom enclosures: `tests/metadata.test.ts`; the site samples are shaped like the services' documented answers, not recorded: see VDH-046)
- [x] Adapters make anonymous requests only and are validated like any other URL (same-origin, `credentials: 'omit'`, 3 s and 2 MB limits, every address http(s) only; E2E checks the API request carries no cookie and a feed on a foreign origin is never contacted)
- [x] E2E against local mock APIs shaped like the real ones (a PeerTube-shaped instance and a page with Open Graph / JSON-LD / a podcast feed; the listed file downloads and decodes). Commons and the Internet Archive are recognised by host name only, so they are covered by unit tests, not E2E

## Notes

- Generic metadata (`lib/metadata.ts`, `content/metadata.ts`): `og:video` / `og:audio` / `twitter:player:stream`, JSON-LD `contentUrl` of VideoObject and AudioObject (never `embedUrl`, which is a web page),
  `<link rel="alternate">` to media files, and the enclosures of RSS/Atom feeds the page links to. Candidates are reported with the new detection method `metadata`.
- Open sites (`lib/sites/*`): recognised by the page address only. Wikimedia Commons / Wikipedias (`/wiki/File:...` -> `api.php`, original + transcodes), Internet Archive (`/details/<id>` ->
  `/metadata/<id>`, audio and video files), PeerTube (`/w/<id>`, `/videos/watch/<id>`, `/videos/embed/<id>` on any instance -> `/api/v1/videos/<id>`, confirmed by the shape of the answer). Method `site-api`.
- The lookups run inside the page's own origin (the content script), so they are the same requests a script of the page could make; nothing is sent to any other server. Feeds are read only when they are on the page's origin.
- Not implemented, deliberately: **oEmbed**. Its endpoints are third-party servers (asking them sends the page address to them) and the answer is embed HTML, not a file. **No YouTube/Vimeo-style
  extractors and no per-site code for streaming services**, as agreed.
- Found while verifying: the XML reader had a literal U+FFFF in a regular expression. Bundled into the content script (feeds are parsed there now) it made Chrome refuse to load the script ("isn't UTF-8
  encoded") and broke every scan. The source now uses an escape, and `check:dist` fails the build if any script contains a Unicode noncharacter.
