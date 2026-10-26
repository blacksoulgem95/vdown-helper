---
id: VDH-046
title: Verify the open-site adapters against the real services
status: todo
priority: P3
area: test
depends_on: [VDH-041]
---

# VDH-046: Verify the open-site adapters against the real services

## Description

The Wikimedia Commons, Internet Archive and PeerTube adapters (VDH-041) were written from the services' public API documentation and tested against samples
shaped like the documented responses and a local PeerTube-shaped mock. The build environment has no internet access, so no real response was recorded. Check each
adapter on a real page and replace the hand-written samples in `tests/fixtures/sites/` with recorded responses.

## Acceptance criteria

- [ ] Commons: a `File:` page of a video lists the original and its transcodes with working addresses (check `derivatives[].src` is what the API really returns)
- [ ] Internet Archive: a `/details/<id>` page of a movie and of an audio item lists their files and the downloads work
- [ ] PeerTube: a real instance's `/w/<id>` page lists the web-video files and the HLS playlist; a private or password-protected video lists nothing
- [ ] The samples in `tests/fixtures/sites/` are replaced by recorded responses and the unit tests still pass

## Notes

Manual: needs a normal Chrome with the extension loaded and internet access.
