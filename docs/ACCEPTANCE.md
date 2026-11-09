# Release acceptance

This record covers **v0.4.0**, checked on **2026-09-27 UTC**, and preserves the v0.3.0 baseline below. The [v0.4.0 acceptance section](#040-deterministic-setup-acceptance) supersedes the baseline test counts and setup behavior. It separates implemented behavior, authenticated evidence, and remaining work. It is not a claim that every original requirement has been exercised against every account or browser.

The original request is preserved in [SPEC.md](SPEC.md). Generated operation/surface availability is recorded in [COVERAGE.md](../COVERAGE.md); an operation appearing there does not establish runtime correctness or registry publication.

## v0.3.0 baseline checks

| Check | Result | Evidence and scope |
| --- | --- | --- |
| `npm test` | **137 passed**, 13 live tests skipped; 18 files passed, 2 skipped | Fresh run against this candidate, 2026-09-27 04:57 UTC; exit 0. Covers auth orchestration, credential validation, session storage, GPA parsing/calculation, prerequisite planning, scheduler, and read/write boundary regressions. |
| `npm run test:live` | **13 passed** in 2 files | Fresh read-only run, 2026-09-27 04:57 UTC; exit 0, 46.39 seconds. Used the account-configured host vault, not fixtures or a checked-in `.env`. |
| `npm run build` | **Passed** | TypeScript/library build and package preparation. |
| `npx toolfactory check` | **Passed** | Operation snapshot and generated-file drift gate. |
| `npx toolfactory validate` | **28 checks passed** | Fresh validator run, exit 0. Includes MCP discovery, npm package validation, OpenClaw mock/runtime surface validation, web build/smoke, browser tests, Chrome/Firefox builds, and Firefox lint. This does not substitute for authenticated end-to-end behavior. |
| `VUTOOLKIT_LIVE=1 node scripts/test-yes-browser.mjs` | **Passed** | Production extension and web interactions with synthetic responses, plus authenticated real YES extension mounting with mutation requests blocked. The command exited 0 after correcting a fixture selector that had mistaken an injected professor link for a cart action; no production fix was needed. |

Live tests are a native Tool Factory live-test tier: [`dev.toolfactory/tool.json`](../dev.toolfactory/tool.json) declares the opt-in credential marker and disables account-bound tests in hosted CI; [`scripts/test-live.mjs`](../scripts/test-live.mjs) runs the real suites. Missing authentication fails the opted-in run instead of silently falling back to synthetic data. Reporters emit assertions/counts, not transcript values, addresses, cookies, or tokens.

### Authenticated tests

The eight tests in [`tests/live.test.ts`](../tests/live.test.ts) verify:

1. A healthy Vanderbilt session.
2. A healthy Microsoft session.
3. Microsoft Graph `/me` matches the configured account identity.
4. A real YES transcript with independent posted term and cumulative GPA totals.
5. Every posted term GPA and the posted cumulative GPA reproduce from the transcript.
6. Hypothetical grades apply to real in-progress courses without mutating the transcript.
7. Cookie-header, CDP, and Playwright session-export shapes for both identity providers.
8. The real OneVU enrollment page can be prepared while preserving the existing key; no new passkey is issued.

The five tests in [`tests/yes-live.test.ts`](../tests/yes-live.test.ts) verify:

1. Official audit requirements and existing planner courses form a directed representation with valid edge references.
2. Official course alternatives resolve for a real audit requirement.
3. A live course description supplies a parsed OR prerequisite expression.
4. Live section alternatives can be solved without modifying the cart.
5. Public Vanderbilt professor ratings resolve without sending Vanderbilt credentials to the ratings service.

These checks allow healthy session reuse. This run does **not** independently prove forced fresh login from an empty browser/session cache, every prerequisite prose format, or a new passkey's first subsequent sign-in.

## Original feature matrix

| Original requirement | Implementation | Verification and remaining boundary |
| --- | --- | --- |
| OneVU passkey authentication and cached SSO | `sessions.ensure`, `sessions.refresh`; host-vault credential resolution and dedicated CDP tabs | Auth orchestration unit-tested; current authenticated health verified. A destructive cache reset is not part of the release suite. |
| Microsoft session and generic Graph access | Microsoft session chain; `graph.call` with injected auth | Configured identity and session health verified live. This suite does not send mail, edit calendars, or exercise every Graph endpoint. |
| Reusable sessions for other authorized clients | Ingest, export, refresh, forget, metadata listing; Cookie/CDP/Playwright formats | Both identity-provider export shapes verified live; storage and scope filtering unit-tested. Individual third-party services still have their own browser/API requirements. |
| Academic record including unposted courses | Live YES record adapter | Live transcript and posted totals verified; projection uses its in-progress courses. No private student record is included in this repository. |
| Term and cumulative what-if GPA | Pure calculation engine; official-total verification | All posted term and cumulative comparisons pass on the configured live account. Synthetic tests cover grading and projection cases. |
| Official degree audit and planner data | `degree.audit`, `degree.graph`, `degree.options` | Requirements, real satisfiers, and existing planner nodes verified live. Official audit timestamps/status remain authoritative; the toolkit does not rerun the audit or alter the official planner. |
| Directed prerequisite graph and alternative ranking | `planner.graph`; recursive catalog exploration in the D3 UI; completed/planned courses and explicit preference weights | Deterministic AND/OR, shared-credit, cycle, unknown-data, and truncation behavior unit-tested. A real OR expression is checked live. This is **not** a complete global degree-completion optimizer. |
| Course/professor/time/location metadata | Live course/section adapters and public professor lookup | A real course, section set, and professor lookup verified. Namesake ambiguity remains explicit. |
| Browser scheduler replacing VandyScheduler | Conflict-free combinations, multiple meetings, lecture/lab groups, TBA warnings, excluded courses/sections, persistent free-time preferences, bulk cart controls, RMP links, schedule selection | Algorithms unit-tested. Real cart mutation and enrollment are not exercised by the read-only live suite. See the browser evidence section below. |
| Guided setup issuing and securely storing a passkey | `setup.identity`, `setup.status`, `setup.prepare`, `setup.enroll`; setup panel | Recovery-safe flow stages and reads back a fresh key, waits for OneVU enrollment acknowledgement and configured-identity match, preserves an older key in the host vault, then promotes. Synthetic regression tests cover preservation, wrong-account/unavailable-browser gates, and incomplete vault confirmation. The OpenClaw Browser panel provides interaction with the same `openclaw` managed profile. **Issuing a new live key and the user's panel handoff remain unverified.** The final `sessions.ensure` result distinguishes fresh sign-in from cached-session reuse. |
| Library, CLI, MCP, OpenClaw, web, and extension surfaces | One operation canon plus Tool Factory generated host surfaces | Generated exposure is separate from live behavior. Refer to release gates and browser evidence; not every operation has a live test through every host. |

## Browser evidence and VandyScheduler parity

[`scripts/test-yes-browser.mjs`](../scripts/test-yes-browser.mjs) exercises the production extension and web bundles with isolated synthetic responses; `VUTOOLKIT_LIVE=1` additionally checks mounting on authenticated YES with mutation requests blocked. Synthetic cart actions must not be described as successful live cart writes.

The complete browser run passed on 2026-09-27. Synthetic checks covered persisted preferences, schedule selection, bulk cart controls, professor links, the web audit/graph and official alternatives, course/professor metadata, prerequisite exploration, and setup consent controls. The authenticated check confirmed that the production extension mounted on the real YES page; it did not change the cart.

Parity is compared with the upstream [VandyScheduler README and changelog](https://github.com/quinton22/VandyScheduler/blob/master/README.md), read on 2026-09-27:

| Upstream feature | vutoolkit counterpart |
| --- | --- |
| Add all available section times; choose a schedule into the cart | Bulk add/remove controls and cart-only schedule selection |
| Generate nonconflicting schedules; account for labs and multiple meeting times | Shared `scheduler.solve` engine with component grouping and per-meeting conflict checks |
| Choose free periods and exclude courses | Persisted course/section and free-time preferences |
| Indicate unsatisfiable combinations and uncertain times | Conflict-group reporting, empty-required-group regression coverage, explicit TBA warnings |
| Professor ratings and profile links | Public RMP lookup with caching and namesake-aware links |
| One-click enrollment | **Intentionally not implemented:** the original vutoolkit brief replaces enrollment with cart modification. No enrollment control is invoked. |

The implementation covers these requested categories, but **100% live behavioral parity is not yet established**: actual cart writes have not been tested against YES. Lecture/lab linkage is enforced when supplied in the data; the current scraped source may not expose all official linked-section eligibility rules. The account's actual enrollment validity remains Vanderbilt's decision.

## Remaining acceptance work and deliberate limits

- **First-time enrollment:** conduct an account-owner-approved real `setup.enroll`, confirm the vault read-back and server registration, and verify login with that new credential. Existing account credentials must not be replaced merely for acceptance testing.
- **Real cart acceptance:** verify add/remove and schedule selection on a consenting account, including read-back. Enrollment changes are out of scope. Current live checks deliberately block these requests.
- **Complete degree-path optimization:** alternatives load per official requirement; prerequisite ranking explores known catalog metadata with declared bounds. Arbitrary prose, missing metadata, official conditional rules, and truncated searches are not proven globally optimal. Ranking is credit cost minus explicit preference weights, not autonomous inference of the student's interests from email or other private sources.
- **Other browsers and new accounts:** a successful build is not an installed-browser test. Firefox/Edge/Safari runtime behavior and a second account's authenticated flow require separate evidence.
- **Distribution and installations:** publication receipts, npm trusted-publisher configuration, and each host's loaded version are release/deployment checks, not implied by the source tests. See [RELEASING.md](RELEASING.md).
- **Browser store submission:** Chrome Web Store, Firefox Add-ons, and Edge Add-ons submissions, their security reviews, and installed-from-store verification have not been attempted — see "S06 browser store publication coverage" above and [RELEASING.md](RELEASING.md#browser-store-submission) for the procedure and the blocking asset gap.

No passkey enrollment, academic write, cart change, Graph mutation, or email send is required by the read-only release suite.

## 0.4.0 deterministic setup acceptance

`setup.run` replaces LLM-driven first-time login with a bounded deterministic flow. Identity and optional password resolve from the account's own host vault; no credential arguments are accepted. Existing-browser reuse, explicit rejected-key recovery, no-interaction mode, pending-key protection, identity mismatch, vault readback, partial Microsoft readiness, and named errors are regression-tested. Browser selection honors explicit endpoints and compatible profiles.

Live account enrollment and installed-version receipts are recorded separately in the release verification report; fixture success alone is not live enrollment proof. No real cart or enrollment changes are part of this release's read-only academic checks.

On 2026-09-27, v0.4.0 passed 178 unit tests, 28 surface validators, the production synthetic browser checks (including exactly one setup operation from the Connect action), and all 13 read-only live tests. `setup.run({confirm:true,allowInteractiveVerification:false})` on the existing release account returned `ready`, verified a real isolated passkey assertion, and established both Vanderbilt and Microsoft sessions. This is existing-key acceptance, not new-key enrollment proof.

## S02 hardening coverage

Slice S02 (cart and course section selection controls) adds synthetic unit and browser hardening coverage on top of the already-shipped cart/section-selection and preference-persistence UI, closing gaps identified during slice research. New unit tests close professor-lookup failure-mode coverage (`src/yes/professors.test.ts`), parser day-notation/missing-field/mismatched-count edge cases (`src/yes/more-parser.test.ts`), and scheduler multi-term-guard/multi-component-linkage/mixed-component `cartDifference` edge cases (`src/yes/scheduler.test.ts`). `scripts/test-yes-browser.mjs` now also exercises `clickCartAction`'s retry-timeout error path and the professor-lookup failure fallback UI. This is synthetic hardening, not a live cart mutation: the "Real cart acceptance" gap above remains open and unverified by this work.

## S03 conflict highlighting coverage

Slice S03 (schedule solver integration and conflict detection) closes the visual gap identified in `02-03-RESEARCH.md`: the schedule solver (`src/yes/scheduler.ts`) already enumerated non-conflicting schedules and detected incompatible course/component groups via `sectionsConflict` and `solveSchedules`'s `incompatibleGroups`, but conflicts were previously surfaced only as text inside the "Make schedule" error dialog, never on the YES search-results page itself. `hosts/browser/utils/yes-ui.ts`'s `scan()` now runs a separate per-table pass that reuses the existing `sectionsConflict` function (no new conflict-detection rule) to mark search-result rows that conflict with the current cart with a `data-vutoolkit-conflict` attribute, a tooltip, and distinct styling; rows already in the cart are never marked against themselves, and stale marks clear once a conflict resolves. `scripts/test-yes-browser.mjs` exercises this with a new Playwright scenario covering a conflicting alternative, a non-conflicting alternative, continued bulk add/remove success, unaffected schedule-generation output, and a 50+ row scale check with no page errors. This is synthetic, client-side UI coverage only; it adds no live cart-mutation proof, and the "Real cart acceptance" gap above remains open and unverified by this work.

## S04 professor candidate picker coverage

Slice S04 (professor metadata and RMP integration) closes the disambiguation gap identified in `02-04-RESEARCH.md`: `searchProfessors` (`src/yes/professors.ts`) already returned up to 10 RMP candidates per lookup and `scan()` (`hosts/browser/utils/yes-ui.ts`) already rendered ratings for an exact-name match, but when a YES professor name had multiple non-exact candidates, `scan()` rendered only a single "RMP: choose match" link to an external RMP search page, forcing the user to leave YES to disambiguate. `mountYesScheduler` now accepts optional `loadProfessorMappings`/`saveProfessorMapping` callbacks, wired in `hosts/browser/entrypoints/yes.content.ts` through a new `vuToolkitProfessorMappings` `browser.storage.local` key (the same single-object-key, read-modify-write pattern already used for scheduler preferences). When a name has no exact match, `scan()` now renders an inline `<select>` listing each candidate (name, rating, rating count) plus a "Find on RMP (no match)" escape option, instead of the single external link; choosing a candidate persists the mapping and replaces the select with the same rating-link UI used for exact matches, and later scans/reloads reuse the cached mapping without a repeat RMP request. `scripts/test-yes-browser.mjs` adds a Playwright scenario covering picker rendering (placeholder plus per-candidate options plus the "none" escape option), selection persistence across reload with no repeat RMP call, and that the picker does not interfere with the existing bulk "Add all sections to cart" flow. This is synthetic, client-side UI coverage only; it adds no live-account proof, and the "Real cart acceptance" gap above remains open and unverified by this work — this slice does not touch cart mutation at all.

## S05 onboarding coverage

Slice S05 (setup onboarding and authenticated integration) closes a discoverability gap, not a functional one: `setup.identity`/`setup.status`/`setup.prepare`/`setup.run` and the `SetupPanel` UI already existed and were already live-verified (see "0.4.0 deterministic setup acceptance" above), but nothing routed a freshly installed extension toward that flow or confirmed onboarding had happened. S05 adds three pieces of wiring only: a `browser.runtime.onInstalled` handler in `hosts/browser/entrypoints/background.ts` that, on a fresh install, sets `onboarded: false` in `browser.storage.local` and opens the options page; extension-aware default-to-setup routing in `web/src/App.tsx` that checks the same storage key on mount and switches the active page to "setup" when onboarding is incomplete, plus a one-line "Open full page" hint shown only on the popup surface while onboarding is pending; and an `onConnected` callback prop on `web/src/SetupPanel.tsx`, invoked once `setup.run` reports `status: "ready"`, that the extension host wires to persist `onboarded: true`. Every change is confined to each touched file's non-toolfactory-generated region: `dev.toolfactory/lock.json` marks `hosts/browser/entrypoints/popup/main.tsx`, `options/main.tsx`, `utils/page.tsx`, and the existing test harnesses (`background.test.ts`, `smoke.mjs`) as fully generated, so none of them were hand-edited. `hosts/browser/tests/onboarding.test.ts` adds `fakeBrowser` unit coverage of the install handler, asserting that an `"install"` reason sets `onboarded: false` and opens the options page exactly once, while an `"update"` reason leaves the storage key unset and never opens the options page. `scripts/test-extension-setup.mjs` adds an end-to-end Playwright proof: a freshly loaded, unpaired popup defaults to the setup heading and shows the "Open full page" hint; the options page also defaults to setup, and pairing plus identity-save plus consent-and-connect against a stateful mock kernel drives `setup.run` to `ready`; the options page's `storage.local` then reports `onboarded: true`; and a reopened popup no longer shows the hint. Live passkey issuance and enrollment remain explicitly out of scope for this slice, matching the rest of the release's read-only boundary — the `onboarded` flag is a plain per-browser-profile `storage.local` value with no relationship to the host vault's passkey storage, and no new credential or enrollment path was added.

## S06 browser store publication coverage

Slice S06 (browser store publication and release engineering) prepares the extension for submission to Chrome Web Store, Firefox Add-ons, and Edge Add-ons; it does not submit it. T01 removed the dead `example.content.ts` scaffold, confirmed by `git status` and a passing `npm --prefix hosts/browser run build`. T02 wrote [PRIVACY.md](PRIVACY.md), grounded in the actual storage keys (`endpoint`, `onboarded`, `yesSchedulerPreferences`, `vuToolkitProfessorMappings`, and the session-only `token`) and the three real non-local destinations the kernel talks to (the paired local kernel, Vanderbilt/Microsoft, Rate My Professors). T03 wrote [STORE-LISTINGS.md](STORE-LISTINGS.md) — per-store title/description/category/permission copy with every feature claim cited to a specific earlier acceptance section or source file — and [`hosts/browser/ASSETS.md`](../hosts/browser/ASSETS.md), which catalogs a real, unresolved asset gap: the five manifest icons are WXT's unreplaced placeholders, zero screenshots exist anywhere in the repository, Edge's separate 300×300 Store logo has never been exported, and `docs/PRIVACY.md` has no stable published URL. T04 adds the submission procedure itself to [RELEASING.md](RELEASING.md#browser-store-submission).

**Slice demo claim not yet met.** The slice's stated demo is "Extension is available on all three browser stores with passing security reviews." No submission has been made to any of the three stores as of this writing: the extension has not been uploaded to a developer dashboard, no store-side security review has run, and no publication receipt or installed-from-store verification exists. What exists is the prerequisite documentation — privacy policy, listing copy, asset inventory, submission procedure — a human submitter needs to carry out the remaining steps, several of which are inherently manual and outside this repository's automation: creating and registering each store's developer account, replacing the placeholder icon set and capturing real screenshots, and completing each dashboard's own submission and review flow.

| Store | Submission status | Blocking gap |
| --- | --- | --- |
| Chrome Web Store | Not submitted | Real icon set, ≥1 screenshot, pinned privacy-policy URL, developer registration |
| Firefox Add-ons (AMO) | Not submitted | Same asset gap; the Firefox build/zip (`npm --prefix hosts/browser run zip:firefox`) has not been uploaded |
| Edge Add-ons | Not submitted | Same asset gap plus the separate 300×300 Store logo, which neither Chrome nor Firefox requires |

This is a documentation and release-engineering slice, not a publication slice: it closes the gap between "ready to submit" and "submitted," and leaves submission itself, each store's review outcome, and installed-from-store verification as explicit remaining acceptance work (see below).

## v0.4.0 distribution status

Checked 2026-09-27 UTC. Distribution is tracked independently from passing tests.

| Surface | Observed state |
| --- | --- |
| GitHub | [v0.4.0](https://github.com/GoatInAHat/vutoolkit/releases/tag/v0.4.0) is public with ten assets. [CI on main](https://github.com/GoatInAHat/vutoolkit/actions/runs/36317877359) passed on Node 22 and 24. |
| ClawHub skill | `vutoolkit` v0.4.0 published. Skill installation alone does not install a runtime. |
| ClawHub native plugin | `openclaw-plugin-vutoolkit` v0.4.0 published; registry scan status is **suspicious**, not cleared. Findings include command execution, dependency dynamic-code paths, credential/network handling, and the professor lookup's client authorization header. |
| npm | Package lookup returns 404; [release job](https://github.com/GoatInAHat/vutoolkit/actions/runs/36317813643) passed validation/packaging but failed the first npm publication with E404. Trusted publishing still requires the authenticated bootstrap described in [RELEASING.md](RELEASING.md). |
| Installed hosts | Both requested live v0.4.0 installations are not yet verified. A built or linked package and a separate CLI runtime inspection are not proof of the running gateway's tool catalog. |
| Chrome Web Store | Not submitted. See "S06 browser store publication coverage" above. |
| Firefox Add-ons (AMO) | Not submitted. See "S06 browser store publication coverage" above. |
| Edge Add-ons | Not submitted. See "S06 browser store publication coverage" above. |

The native plugin's bundled dependencies permit installation without a separate npm core package. This does not remove the ClawHub review requirement or establish live authentication on another account. No published version was overwritten to change package contents.
