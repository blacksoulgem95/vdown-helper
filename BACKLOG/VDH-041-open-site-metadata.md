---
id: VDH-041
title: Metadata and open-site recognition
status: todo
priority: P2
area: lib
depends_on: [VDH-033]
---

# VDH-041: Metadata and open-site recognition

## Description

Recognise media through public, standard metadata (Open Graph, JSON-LD VideoObject, link rel=alternate, oEmbed, RSS enclosures) and public APIs of Wikimedia Commons, Internet Archive and PeerTube. No private APIs, no logins, no per-site scraping of any streaming site.

## Acceptance criteria

- [ ] Metadata parsers unit-tested with recorded samples
- [ ] Adapters make anonymous requests only and are validated like any other URL
- [ ] E2E against local mock APIs shaped like the real ones

## Notes

_None yet._
