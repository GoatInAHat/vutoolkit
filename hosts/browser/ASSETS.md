# Store submission assets

What each browser store needs as a visual/metadata asset to accept a submission, what this
repository currently has, and what is still missing. Listing copy (title, descriptions,
category) lives in [`docs/STORE-LISTINGS.md`](../docs/STORE-LISTINGS.md); this file is assets
only. Checked against v0.4.5.

## Current state: icons

| Size | Present | Source |
| --- | --- | --- |
| 16×16, 32×32, 48×48, 96×96, 128×128 | Yes — `hosts/browser/public/icon/*.png` | WXT's placeholder set |

All five manifest icon sizes exist and are the correct dimensions. **They are placeholders,
not vutoolkit branding** — `hosts/browser/README.md` names them explicitly as "WXT's placeholder
set, copied in by `npx toolfactory validate`; replace them with your own." No vutoolkit logo,
wordmark, or icon design exists anywhere in this repository yet. Submitting with the current
icons means every store listing, the toolbar button, and the extensions-page entry show WXT's
generic icon instead of a project identity.

**Gap:** a real icon design, exported at all five sizes into
`hosts/browser/public/icon/{16,32,48,96,128}.png`, replacing the placeholders in place (the
manifest already references these exact paths, generated from `wxt.config.ts` — no config
change needed once the files are replaced).

## Current state: screenshots

**None exist.** No screenshot, promotional tile, or marketing image exists in this repository
(`hosts/browser/`, `docs/`, or elsewhere) for the YES content-script UI, the popup, the options
page, the degree-planner graph, or the setup flow.

All three stores require at least one screenshot before a submission can be published:

| Store | Minimum | Maximum | Dimensions |
| --- | --- | --- | --- |
| Chrome Web Store | 1 | 5 | 1280×800 (recommended) or 640×400, PNG or JPEG |
| Firefox Add-ons (AMO) | 0 required, but strongly recommended | — | No fixed dimension enforced; follow the add-on's natural aspect ratio |
| Edge Add-ons | 1 | 10 | 1280×800 or 640×480, PNG |

**Gap:** at minimum one screenshot per store (the same image works for all three, sized to the
largest common dimension — 1280×800 — and downscaled if needed). The most representative shots,
in priority order:

1. The YES class-search results page with the inline conflict highlighting and a professor
   rating visible (the two features with no VandyScheduler equivalent).
2. The bulk cart controls plus the schedule-selection result (the direct VandyScheduler-parity
   feature).
3. The professor disambiguation picker showing multiple RMP candidates.
4. The full-page degree-planner graph.
5. The "Connect Vanderbilt" setup page.

These need a real (or realistic synthetic) YES session to capture — `scripts/test-yes-browser.mjs`
and `scripts/test-extension-setup.mjs` already drive Playwright against synthetic/mock YES and
kernel fixtures and could be adapted to save a screenshot at the relevant step, but no such
capture step exists yet. No existing test currently writes an image file.

## Current state: store-specific extra assets

| Asset | Required by | Present | Notes |
| --- | --- | --- | --- |
| 300×300 Store logo | Edge Add-ons | **No** | Distinct from the manifest icon set — Edge's submission form asks for this logo as a separate upload, not derived from `public/icon/128.png`. Needs its own export at 300×300. |
| Small/marquee promo tiles (440×280, 920×680, 1400×560) | Chrome Web Store | No | Currently optional in the Chrome dashboard for a new listing (promotional images are not required to publish); not a blocker, but worth tracking if the dashboard reintroduces a requirement. |
| Privacy policy URL | All three | No stable URL assigned | `docs/PRIVACY.md` exists and is accurate (see `S06-T02-SUMMARY.md`), but no store form has been given a URL for it. A GitHub blob link pinned to the `v0.4.5` release tag (not `main`, so the reviewed text can't drift under the link after submission) is the straightforward option: `https://github.com/GoatInAHat/vutoolkit/blob/v0.4.5/docs/PRIVACY.md`. |

## Summary: before any store submission

- [ ] Design and export a real icon set at 16/32/48/96/128px, replacing the WXT placeholders in
  `hosts/browser/public/icon/`.
- [ ] Export the same mark at 300×300 for Edge's separate Store logo upload.
- [ ] Capture at least one, ideally all five, listed screenshots at 1280×800.
- [ ] Pin a release-tagged URL to `docs/PRIVACY.md` and use it in all three submission forms.

None of this blocks the extension's own build or test suite — `npm --prefix hosts/browser run
build` and the Playwright suites do not read or validate these assets. It blocks only store
*submission*, which is why it is called out here rather than treated as a build failure.
