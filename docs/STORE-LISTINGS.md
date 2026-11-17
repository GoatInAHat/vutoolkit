# Store listing copy

Draft listing copy for the vutoolkit browser extension (`hosts/browser`) on the Chrome Web
Store, Firefox Add-ons (AMO), and Edge Add-ons. Every feature claim below is scoped to what
[ACCEPTANCE.md](ACCEPTANCE.md) records as implemented and verified for v0.4.5 — it does not
claim real cart mutation, real enrollment, or behavior on a browser/account that hasn't been
tested. Required visual assets (icons, screenshots, store logos) are tracked separately in
[`hosts/browser/ASSETS.md`](../hosts/browser/ASSETS.md); this document is copy only.

## Grounding facts (same for all three stores)

- **What it is a client of.** The extension is a thin client for a vutoolkit kernel the student
  runs themselves (`vutoolkit mcp --http`, or an OpenClaw plugin install they control). It has
  no bundled or developer-operated backend. The manifest (`hosts/browser/wxt.config.ts`)
  requests one permission, `storage`, and `host_permissions` limited to `http://127.0.0.1/*`
  and `http://localhost/*` — it cannot reach any other network address itself. See
  [PRIVACY.md](PRIVACY.md) for the full data-handling account; link to it as the privacy policy
  URL each store's submission form requires.
- **Where it runs.** The one content script matches
  `https://*.vanderbilt.edu/more/SearchClasses*` — the YES class-search page
  (`hosts/browser/entrypoints/yes.content.ts`). The popup and options page are the same `web`
  app surface (`web/src/App.tsx`): an "Operations" page (direct calls to any of the 26 kernel
  operations), a "Degree planner" page (the prerequisite/degree-audit graph), and a "Connect
  Vanderbilt" setup page.
- **What it deliberately does not do.** No one-click enrollment and no cart-mutation request
  has been exercised against the real YES account (`ACCEPTANCE.md`, "Remaining acceptance work
  and deliberate limits"). The original brief explicitly substitutes cart modification for
  VandyScheduler's enrollment action — this is a design choice, not a missing feature, and
  listing copy must not imply enrollment.
- **Affiliation.** Independent, community-built project. Not affiliated with, endorsed by, or
  operated by Vanderbilt University, Microsoft, or Rate My Professors.
- **Version.** v0.4.5 (`hosts/browser/package.json`), matching the root package version.

## Shared feature highlights

Use this list (trimmed per store's format) for every "what it does" section. Each line is
backed by the cited evidence:

- Builds conflict-free YES schedules across multiple meeting times, labs, and linked lecture/lab
  components, with explicit warnings for TBA times (`scheduler.solve`; `ACCEPTANCE.md` "Original
  feature matrix").
- Highlights conflicting search results directly on the YES class-search table before you add
  them, instead of only failing at "Make schedule" time (S03, `yes-ui.ts` `scan()`).
- Bulk add/remove cart controls and persisted free-time and excluded-course/section preferences,
  replacing the discontinued VandyScheduler extension feature-for-feature on these points (S02;
  "Browser evidence and VandyScheduler parity").
- Shows public Rate My Professors ratings inline on YES; when a professor name matches more than
  one RMP profile, an inline picker lets you disambiguate once and remembers your choice (S04).
- A "Connect Vanderbilt" setup flow that issues and verifies a passkey-backed session without
  ever asking you to paste a password into the extension (`setup.run`; "0.4.0 deterministic
  setup acceptance").
- A degree-planner graph and a direct operations explorer in the full-page view, covering
  official degree-audit requirements, course alternatives, prerequisite ranking, what-if GPA,
  and Microsoft Graph access — all served by your own local kernel, not the extension.
- Nothing is sent to the developer or to any analytics/advertising service; the only non-local
  destinations the kernel talks to are Vanderbilt's, Microsoft's, and Rate My Professors'
  servers, for your own data (`PRIVACY.md`).

---

## Chrome Web Store

Field limits per the [Chrome Web Store listing dashboard](https://developer.chrome.com/docs/webstore/cws-dashboard-listing): title ≤75 characters, short description ≤132 characters.

**Title** (requirement: must correspond to the manifest `name`, "vutoolkit"; 54 chars)
```
vutoolkit — YES Scheduler & GPA Planner for Vanderbilt
```

**Short description** (132 char limit; 124 chars)
```
Conflict-free YES scheduling, cart tools, and professor ratings for Vanderbilt — powered by your own local vutoolkit kernel.
```

**Detailed description**
```
vutoolkit is a scheduling and planning companion for Vanderbilt's YES system, built to replace
the discontinued VandyScheduler extension feature-for-feature and add official degree/GPA
tooling on top.

On the YES class-search page, it:
- Builds conflict-free schedules across multiple meeting times, labs, and linked lecture/lab
  sections, with explicit warnings when a section's time is still TBA.
- Marks conflicting search results inline, before you add them to your cart.
- Adds bulk "add all sections" / "remove" cart controls, and remembers your excluded courses,
  excluded sections, and free-time preferences across visits.
- Shows public Rate My Professors ratings next to each professor, with an inline picker when a
  name matches more than one RMP profile.

In its full-page view, it also gives you:
- A directed degree-planner graph built from your official YES degree audit and course
  alternatives, with prerequisite ranking against your completed and planned courses.
- A guided "Connect Vanderbilt" setup flow that issues a passkey-backed session — no password
  typed into the extension.
- Direct access to the same operations (what-if GPA verified against your official transcript,
  Microsoft Graph, session export) that power the vutoolkit CLI and MCP server.

How it works: this extension has no backend of its own. It pairs with a vutoolkit kernel that
you run yourself — either the open-source `vutoolkit` package (`vutoolkit mcp --http`) or an
OpenClaw plugin install you control — over loopback only (http://127.0.0.1 or http://localhost).
That kernel holds your Vanderbilt/Microsoft session, not the extension or its developer. See our
privacy policy for the full account of what is stored and transmitted, and where.

vutoolkit never performs class enrollment and has not yet been verified to mutate a real YES
cart; it reports planned changes and lets Vanderbilt's own enrollment flow stay the final step.

This is an independent, community-built project. It is not affiliated with, endorsed by, or
operated by Vanderbilt University.

Source, acceptance evidence, and the privacy policy: https://github.com/GoatInAHat/vutoolkit
```

**Suggested category:** Education (closest primary-use-case fit; Chrome's newer taxonomy also
lists "Workflow & Planning" as a reasonable secondary pick — confirm both are still offered at
submission time, since Chrome has revised its category list before).

**Single-purpose description** (required by Chrome's [Program Policies](https://developer.chrome.com/docs/webstore/program-policies) "single purpose" rule, entered separately from the listing):
```
Helps a Vanderbilt student plan and build a conflict-free YES class schedule, using their own
locally run vutoolkit kernel for the academic data and session the scheduler needs.
```

**Permission justifications** (required per-permission in the Chrome dashboard):
- `storage`: persists the user's schedule/free-time preferences, saved professor-rating
  disambiguation choices, onboarding state, and the paired kernel endpoint, so the user does not
  re-enter them every visit.
- `host_permissions` (`http://127.0.0.1/*`, `http://localhost/*`): required to call the user's
  own locally running vutoolkit kernel; the extension cannot and does not reach any other host.

---

## Firefox Add-ons (AMO)

Field limit per [Mozilla's listing guidance](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/): summary ≤250 characters. AMO description has no hard limit but Mozilla recommends staying concise; AMO supports a small set of HTML tags (`b`, `i`, `ul`, `li`, `a`) in the description field.

**Name:** `vutoolkit`

**Summary** (250 char limit; 163 chars)
```
Build conflict-free Vanderbilt YES class schedules, see professor ratings inline, and connect your own locally run vutoolkit kernel for GPA and degree-audit tools.
```

**Description** (reuses the Chrome detailed description verbatim with the HTML tags AMO supports — `<ul><li>` for the bullet lists, `<a href="...">` for the two linked URLs)

**Suggested category:** AMO's current category list does not include a dedicated "Education"
entry at the time this was written; pick the closest available option in the actual submission
form (historically a catch-all like "Other" or a general productivity/tools bucket) rather than
guessing one in this document — verify directly on the live AMO submission page, since this
list has changed across AMO revisions.

**Firefox-specific manifest facts already in place** (`hosts/browser/wxt.config.ts`): the
Firefox `browser_specific_settings.gecko` block declares extension ID
`vutoolkit@GoatInAHat.github.io`, `strict_min_version: "140.0"`, and
`data_collection_permissions: { required: ["none"] }` — the last of these should be cited
directly in the AMO data-collection questionnaire during submission, since it is a formal
manifest declaration, not just listing copy.

---

## Edge Add-ons

Field limits (per [Microsoft's publish-extension guidance](https://learn.microsoft.com/microsoft-edge/extensions/publish/publish-extension)): description 250–5000 characters; up to 10 screenshots (640×480 or 1280×800); search terms up to 21 words total; a separate 300×300 Store logo is required (not satisfied by the manifest's largest icon — see ASSETS.md).

**Name:** `vutoolkit`

**Short/search description** (reuse the Chrome short description — 124 chars, inside Edge's range)

**Description** (reuse the Chrome detailed description verbatim — within the 250–5000 char range)

**Suggested search terms** (≤21 words total; 18 words):
```
Vanderbilt YES scheduler GPA planner degree audit prerequisite scheduling cart conflict
professor ratings passkey SSO Microsoft Graph VandyScheduler
```

**Suggested category:** Education (confirmed available in Edge Add-ons' category list alongside
Productivity; Productivity is a reasonable secondary pick if Education is unavailable at
submission time).

---

## Cross-store compliance checklist

- [x] Feature claims above are each backed by an `ACCEPTANCE.md` section or a specific source
  file — no claim describes untested cart mutation or enrollment as working.
- [x] Every store's copy names the loopback-only kernel dependency and links the privacy policy,
  satisfying each store's "explain what data you handle and why" requirement.
- [x] "Independent, not affiliated with Vanderbilt" disclosure is present in every description,
  addressing each store's policy against implying an official or endorsed relationship.
- [ ] **Not yet satisfied:** every store also requires visual assets (icon set, screenshots, and
  Edge's separate 300×300 logo) that do not exist as submission-ready files yet. See
  [`hosts/browser/ASSETS.md`](../hosts/browser/ASSETS.md).
- [ ] **Not yet satisfied:** the privacy policy URL each form asks for needs to resolve to a
  stable, public page. `docs/PRIVACY.md` exists in this repository but has not yet been given a
  canonical published URL (e.g. a GitHub blob link pinned to a release tag) — assign one before
  submitting any of the three forms above.
