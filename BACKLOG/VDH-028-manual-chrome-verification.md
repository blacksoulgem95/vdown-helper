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

- [ ] Options -> "Look inside players" shows Chrome's all-sites prompt and enables the hook; revoking access removes it
- [ ] "Allow embedded players" in the popup asks for exactly the listed frame origins, then the nested players appear

## Notes

Nothing here has been verified yet; all boxes are intentionally unchecked.
