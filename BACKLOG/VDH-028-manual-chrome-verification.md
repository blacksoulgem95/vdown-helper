---
id: VDH-028
title: Manual verification in branded Google Chrome
status: todo
priority: P1
area: test
depends_on: [VDH-018]
---

# VDH-028: Manual verification in branded Google Chrome

## Description

What automation cannot prove. Follow the manual test procedure in the README in real Chrome (desktop, ideally also Windows and macOS).

## Acceptance criteria

- [ ] Click the toolbar icon: scanning works with only `activeTab` (no host permission granted)
- [ ] `ALLOW SITE ACCESS` and the start of an HLS download show Chrome's per-site prompt, and granting it makes the download work
- [ ] Settings → Scan pages automatically / Observe media requests show the all-sites prompt; revoking it switches the UI back
- [ ] `CONFIGURE` opens the real side panel on the clicked tab
- [ ] Open file / Show in folder work from the popup
- [ ] Unicode file names save correctly
- [ ] A real multi-GB VOD stays responsive and can be cancelled

- [ ] Options -> "Allow all sites and embedded players" shows Chrome's all-sites prompt; "Look inside players" (on by default) then runs everywhere; revoking access removes it
- [ ] "Allow all embedded players" in the popup shows one all-sites prompt, then nested players (every level) appear and other pages no longer ask (VDH-049)
- [ ] Updating from 1.1.x switches _Look inside players_ on once, with no new permission prompt and without disabling the extension (VDH-049)
- [ ] Recording a MediaStream (a webcam test page, a screen share, a WebRTC call page) with "Recording format" set to MP4: the file plays and has sound; with WebM it still works
- [ ] MediaStream recording keeps the "recording" banner visible in a real window, Stop in the banner and in the queue both save, and closing the tab keeps what was recorded
- [ ] Capture (fast and real time) of a real MSE player with H.264/AAC (the test browser has no proprietary codecs): the file plays; a player with EME (Widevine) shows no capture button
- [ ] Recording a live HLS and a live DASH stream from a real, legitimate source you are allowed to record: Stop saves a playable file; the limits in Settings stop it by themselves
- [ ] Real PeerTube instance, Wikimedia Commons `File:` page and Internet Archive item list their files and the downloads work (VDH-046)
- [ ] Page hook: with _Look inside players_ on, a page keeps working normally (no console errors from the page, players behave)
- [ ] Web Store listing and permission forms filled in from `docs/store-policy.md` (submission itself is out of scope)

## Notes

Nothing here has been verified yet; all boxes are intentionally unchecked.
