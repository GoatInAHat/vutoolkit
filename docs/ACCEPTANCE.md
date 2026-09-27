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

No passkey enrollment, academic write, cart change, Graph mutation, or email send is required by the read-only release suite.

## 0.4.0 deterministic setup acceptance

`setup.run` replaces LLM-driven first-time login with a bounded deterministic flow. Identity and optional password resolve from the account's own host vault; no credential arguments are accepted. Existing-browser reuse, explicit rejected-key recovery, no-interaction mode, pending-key protection, identity mismatch, vault readback, partial Microsoft readiness, and named errors are regression-tested. Browser selection honors explicit endpoints and compatible profiles.

Live account enrollment and installed-version receipts are recorded separately in the release verification report; fixture success alone is not live enrollment proof. No real cart or enrollment changes are part of this release's read-only academic checks.

On 2026-09-27, v0.4.0 passed 178 unit tests, 28 surface validators, the production synthetic browser checks (including exactly one setup operation from the Connect action), and all 13 read-only live tests. `setup.run({confirm:true,allowInteractiveVerification:false})` on the existing release account returned `ready`, verified a real isolated passkey assertion, and established both Vanderbilt and Microsoft sessions. This is existing-key acceptance, not new-key enrollment proof.


## v0.4.0 distribution status

Checked 2026-09-27 UTC. Distribution is tracked independently from passing tests.

| Surface | Observed state |
| --- | --- |
| GitHub | [v0.4.0](https://github.com/GoatInAHat/vutoolkit/releases/tag/v0.4.0) is public with ten assets. [CI on main](https://github.com/GoatInAHat/vutoolkit/actions/runs/36317877359) passed on Node 22 and 24. |
| ClawHub skill | `vutoolkit` v0.4.0 published. Skill installation alone does not install a runtime. |
| ClawHub native plugin | `openclaw-plugin-vutoolkit` v0.4.0 published; registry scan status is **suspicious**, not cleared. Findings include command execution, dependency dynamic-code paths, credential/network handling, and the professor lookup's client authorization header. |
| npm | Package lookup returns 404; [release job](https://github.com/GoatInAHat/vutoolkit/actions/runs/36317813643) passed validation/packaging but failed the first npm publication with E404. Trusted publishing still requires the authenticated bootstrap described in [RELEASING.md](RELEASING.md). |
| Installed hosts | Both requested live v0.4.0 installations are not yet verified. A built or linked package and a separate CLI runtime inspection are not proof of the running gateway's tool catalog. |

The native plugin's bundled dependencies permit installation without a separate npm core package. This does not remove the ClawHub review requirement or establish live authentication on another account. No published version was overwritten to change package contents.
