---
id: VDH-088
title: Desktop window: its own stylesheet with every utility in it
status: done
priority: P2
area: desktop
depends_on: [VDH-087]
---

# VDH-088: Desktop window: its own stylesheet with every utility in it

## Description

The owner's request after VDH-087: build a separate CSS for the desktop app with everything in it. On the desktop,
size does not matter and nothing is downloaded again, so the window should not depend on Tailwind finding each class
in the sources.

The extension keeps its own lean CSS, which holds only the classes the sources use. The desktop window
(`desktop/ui/src/styles.css`) imports the same theme and adds the generated list of candidates. Tailwind's own design
system gives that list, from the installed version and this theme:

- every utility it knows, with its theme values;
- the theme's colours (and white/black) at every opacity step (0–100 in 5s), for the colour utilities;
- the interactive states (hover, focus, focus-visible, active, disabled, group-hover, aria-selected, aria-pressed) on
  the main colour utilities and on the opacity, underline, cursor, scale, translate and brightness ones.

The scan of the sources (`@source '..'`) stays, so arbitrary values and other variants the code uses are generated too.

Every class with every variant is not possible: the combinations are unbounded, and all classes with ten variants are
already 63 MB.

## Acceptance criteria

- [x] The desktop window's CSS is built from its own entry with the generated candidates; the extension's CSS is
      unchanged
- [x] The window build fails if any utility Tailwind lists, or any class of the shared Tabs component, is missing from
      the window's CSS
- [x] The real app starts and renders as before (tauri-driver E2E and screenshots), and its start-up time is measured
- [x] Full local suite and CI green on the PR head

## Notes

- The list Tailwind 4.3.3 gives for this theme is 23,748 utilities. With the opacity steps and the states, 36,782
  candidates go in, and the window's CSS is 9.9 MB, up from 33 KB. The extension's CSS is byte-for-byte unchanged.
- The check fails when the list is not imported: it reports "lacks 23577 utilities". The Tabs check from VDH-087
  stays. A utility that makes no rule of its own (`group`, `peer`) is tolerated, up to 50.
- The real app with the new CSS passed the tauri-driver E2E 10/10. Screenshots of Queue, Convert and Settings match
  the earlier CSS. The tabs' computed styles are right, with the active one in neon.
- Start-up was measured on release builds under xvfb, 7 runs each. Median first contentful paint: 202 ms with the
  earlier CSS, 774 ms with every utility. The binary is 21.94 MB, up from 21.69 MB, because the assets are compressed.
- `__unstable__loadDesignSystem` is Tailwind's tooling API, pinned by package-lock. If it changes, the generator
  fails: it requires at least 10,000 utilities and rejects any candidate that could break the `inline()` string.
- PR #26 merged as `f0af532` and released in v1.3.16.
  - On the PR head `0fa1cf4`, the full local suite (14 steps) passed, and so did all 20 CI checks, the installers on
    all four OS runners included.
  - Release run 41368821490 is green: each installer is installed and passes the app's self-test.
