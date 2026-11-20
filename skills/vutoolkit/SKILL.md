---
name: vutoolkit
description: Universal toolkit for Vanderbilt student life - OneVU SSO and
  passkey sessions, what-if grades, YES tools; built for AI agents first.
license: MIT
---

# vutoolkit

vutoolkit keeps an authorized Vanderbilt student signed in, with its own passkey for OneVU and the Microsoft 365 sign-in that federates through it, and lets an agent act as that student. Use its signed-in access instead of building a login flow, and never ask the student for a password, code or cookie.

## Runtime prerequisite

This skill supplies instructions, not the runtime or credentials. Check whether the host already exposes `vutoolkit_*` tools or the `vutoolkit` MCP server. If not, follow the [source installation guide](https://github.com/GoatInAHat/vutoolkit#quick-start-from-source); installing this skill alone does not register the plugin.

## Which tool

1. **Any Vanderbilt or Microsoft 365 web API:** `request`. It sends the request as the student and returns the service's own response. Brightspace is D2L, so use its Valence API (`/d2l/api/lp/1.46/users/whoami`, `/d2l/api/lp/1.46/enrollments/myenrollments/`, then per course `/d2l/api/le/1.75/{orgUnitId}/content/toc`, `/dropbox/folders/`, `/grades/values/myGradeValues/`, `/news/`). There are no per-site wrappers: read the service's own API documentation.
2. **Outlook mail and calendar:** on deployments that offer them, `mail.search` (then `mail.read` by id), `mail.folders` and `calendar.view`. For anything else in the mailbox (send, reply, move, rules, out-of-office, availability, contacts), find the action with `owa.actions`, read `owa.describe` for its body, and run it with `owa.call`. Writes there change the real mailbox.
3. **Anything easier in a page than an API (a form, a page without an API):** the `browser.*` tools on deployments that offer them. The browser is already signed in to Vanderbilt and Microsoft 365 and is re-signed in automatically. Start with `browser.navigate`, read with `browser.snapshot`, act with `browser.click`, `browser.type` and `browser.fill_form`.
4. **GPA:** `record.fetch` returns the transcript and a check against Vanderbilt's posted GPAs. Call a projection verified only when `verification.ok` is true. `grades.whatif` projects hypothetical grades and reads the live record itself when no transcript is passed.
5. **Degree planning:** start from `degree.audit` or `degree.graph`, get official alternatives with `degree.options`, then rank paths with `planner.graph`. Keep unknown prerequisites and truncation warnings; a ranked path is not official eligibility.
6. **Scheduling:** fetch live sections with `courses.sections`, then `scheduler.solve`. Check TBA times, components and the term before using a result.
7. **Sessions:** other tools mint and repair sessions themselves. Use `sessions.ensure` (with `force: true` to re-mint) only to warm or repair one, and `sessions.list` to see their health.
8. **First-time setup:** one call to `setup.run({"confirm":true})` once the student has authorized connecting their account; it sends one Okta Verify push. Respect typed errors: `MFA_REQUIRED` means wait for that push, `BROWSER_UNAVAILABLE` means repair the browser connection, and a rejected toolkit key needs the student's explicit `recovery:true` authorization.

## Boundaries

- A request or browser action that changes something (sends mail, submits work, posts, changes a registration) acts as the student. Do it only when the student asked for that action.
- Keep passkeys, cookies and tokens out of chat, logs, commits and reports. `sessions.open` returns raw session material for a local browser; pass it straight to that client and never quote it.
- Use the requested student's own account; installing the plugin does not authorize reusing someone else's session.

<!-- tf:operations -->
## Operations

### courses.detail

Read official YES course description and prerequisite text, preserving ambiguous prose as unknown instead of guessing. Course ID and offer number come from courses.search or the official planner. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `id`, `offerNumber`, `timeoutSeconds`.

`vutoolkit courses.detail --json '<arguments>'` prints a JSON result. MCP tool `courses.detail` on server `vutoolkit` returns the same result as `structuredContent`.

### courses.search

Search the live YES catalog for course IDs, titles, schools and typical offerings. Vanderbilt's keyword search can return broad matches; select by returned course code. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `keywords`, `timeoutSeconds`.

`vutoolkit courses.search --json '<arguments>'` prints a JSON result. MCP tool `courses.search` on server `vutoolkit` returns the same result as `structuredContent`.

### courses.sections

Read live YES section alternatives with campus-local meeting times, professor, room, availability and lecture/lab component. Missing or TBA times are explicit. No cart/enrollment changes. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `keywords`, `termCode`, `timeoutSeconds`.

`vutoolkit courses.sections --json '<arguments>'` prints a JSON result. MCP tool `courses.sections` on server `vutoolkit` returns the same result as `structuredContent`.

### degree.audit

Read Vanderbilt's official degree-audit requirement groups, status, counters and existing planner courses. No audit refresh, enrollment or planner mutation; report timestamps are preserved. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `timeoutSeconds`.

`vutoolkit degree.audit --json '<arguments>'` prints a JSON result. MCP tool `degree.audit` on server `vutoolkit` returns the same result as `structuredContent`.

### degree.graph

Build a directed graph from the authenticated student's official YES audit, including all current requirement groups/lines, satisfying courses and optional planner courses. Official course alternatives load separately via degree.options; this does not invent degree rules. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `timeoutSeconds`.

`vutoolkit degree.graph --json '<arguments>'` prints a JSON result. MCP tool `degree.graph` on server `vutoolkit` returns the same result as `structuredContent`.

### degree.options

Read all official course satisfiers for one current degree-audit requirement line. Report and entry IDs come from degree.audit/degree.graph; the student identity is resolved internally from the authenticated audit. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `reportSequence`, `entrySequence`, `timeoutSeconds`.

`vutoolkit degree.options --json '<arguments>'` prints a JSON result. MCP tool `degree.options` on server `vutoolkit` returns the same result as `structuredContent`.

### grades.whatif

GPA projection: apply hypothetical grades (replacing posted ones, filling unposted ones) and report per-term and cumulative GPAs. Uses the student's live YES record unless a transcript is passed. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `transcript`, `hypotheticals`, `timeoutSeconds`.

`vutoolkit grades.whatif --json '<arguments>'` prints a JSON result. MCP tool `grades.whatif` on server `vutoolkit` returns the same result as `structuredContent`.

### planner.graph

Deterministically rank paths for supplied official requirement alternatives and/or course goals. Shared prerequisites count once; completed and planned work is factored in. Unknown prose, missing metadata, cycles and truncation remain explicit. A model-optimal result is exhaustive only for supplied inputs; degree.audit remains the official authority.

Arguments: `courses`, `completed`, `planned`, `goals`, `requirements`, `preferences`, `maxAlternatives`.

`vutoolkit planner.graph --json '<arguments>'` prints a JSON result. MCP tool `planner.graph` on server `vutoolkit` returns the same result as `structuredContent`.

### professors.search

Look up public Vanderbilt Rate My Professors candidates and ratings. Preserves namesake ambiguity; no Vanderbilt credentials leave the toolkit.

Arguments: `name`.

`vutoolkit professors.search --json '<arguments>'` prints a JSON result. MCP tool `professors.search` on server `vutoolkit` returns the same result as `structuredContent`.

### record.fetch

The student's YES academic record as a parsed transcript (posted terms plus in-progress unposted courses), with a check that recomputes each term's GPA and the cumulative GPA from the posted marks and compares them with Vanderbilt's own posted figures. Trust a what-if only when verification.ok is true. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `timeoutSeconds`.

`vutoolkit record.fetch --json '<arguments>'` prints a JSON result. MCP tool `record.fetch` on server `vutoolkit` returns the same result as `structuredContent`.

### request

Send one HTTP request to any Vanderbilt (*.vanderbilt.edu) or Microsoft 365 (Outlook, Office, SharePoint, login) web endpoint as the signed-in student, and get the service's own response back. The stored sessions ride every sign-in hop (OneVU/Okta, Entra, SAML and OIDC form posts); a refused session is re-minted with the toolkit passkey and the request retried once, so there is no sign-in step for the caller. Use it for the services' own APIs, e.g. Brightspace's D2L Valence API (https://brightspace.vanderbilt.edu/d2l/api/lp/1.46/users/whoami, /d2l/api/lp/1.46/enrollments/myenrollments/, /d2l/api/le/1.75/{orgUnitId}/content/toc, /d2l/api/le/1.75/{orgUnitId}/dropbox/folders/, /d2l/api/le/1.75/{orgUnitId}/grades/values/myGradeValues/, /d2l/api/le/1.75/{orgUnitId}/news/), YES pages, or SharePoint. Outlook's mail APIs (Outlook REST, Microsoft Graph) take an OAuth bearer token, not the signed-in session: a 401 from a Microsoft host is retried once on a freshly minted session, and when it is still 401 it comes back with a trace line saying the endpoint wants a token; read mail in the signed-in browser. Cookie values never appear in the result. YES is read-only: enrollment and cart or planner changes there are refused. A non-GET request elsewhere acts on the student's account: send one only for something the student asked for. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `url`, `method`, `headers`, `body`, `maxChars`, `timeoutSeconds`.

`vutoolkit request --json '<arguments>'` prints a JSON result. MCP tool `request` on server `vutoolkit` returns the same result as `structuredContent`.

### scheduler.solve

Enumerate conflict-free section combinations; include labs, multiple meetings, course exclusions and preferred break times. Deterministic preference ranking and explicit truncation/TBA uncertainty. Returns choices, never enrollment actions.

Arguments: `sections`, `excludedCourses`, `excludedSectionIds`, `blockedTimes`, `hidePreferenceConflicts`, `limit`, `maxSearchNodes`.

`vutoolkit scheduler.solve --json '<arguments>'` prints a JSON result. MCP tool `scheduler.solve` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.ensure

Return the cached session for the IdP when it still works, or mint a fresh one and cache it: the OneVU passkey ceremony for vanderbilt, the Entra carry for microsoft. force=true re-mints even a working session; a failed mint keeps the current one. Other operations call this themselves, so it is only needed to warm or repair a session. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `idp`, `force`, `timeoutSeconds`.

`vutoolkit sessions.ensure --json '<arguments>'` prints a JSON result. MCP tool `sessions.ensure` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.forget

Drop a cached session: removes its row (metadata and values) from the session vault.

Arguments: `idp`.

`vutoolkit sessions.forget --json '<arguments>'` prints a JSON result. MCP tool `sessions.forget` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.ingest

Ingest a harvested browser cookie export into the session store: keeps only cookies in the IdP's domain scope and reports metadata only.

Arguments: `idp`, `sourcePath`.

`vutoolkit sessions.ingest --json '<arguments>'` prints a JSON result. MCP tool `sessions.ingest` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.list

Cached Vanderbilt SSO and Microsoft sessions: metadata only (idp, acquired, expiry, health). Session values never leave the vault.

`vutoolkit sessions.list --json '<arguments>'` prints a JSON result. MCP tool `sessions.list` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.open

Injection payload for a stored session, for a local browser on the student's own machine: raw Cookie header, CDP Network.setCookie params, or Playwright storageState. Never logged or echoed anywhere else. Remote deployments do not offer it. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `idp`, `format`, `timeoutSeconds`.

`vutoolkit sessions.open --json '<arguments>'` prints a JSON result. MCP tool `sessions.open` on server `vutoolkit` returns the same result as `structuredContent`.

### setup.enroll

Issue a toolkit passkey through OneVU's security-method enrollment. Requires authenticated managed-browser sign-in and explicit account-holder confirmation. For recovery only, replaceExisting=true stages and vault-verifies the newly issued credential, preserves the prior key in VANDERBILT_PASSKEY_PREVIOUS, then promotes the new key; use only after the account holder reports the current toolkit key was rejected and confirms the browser is signed into their own configured account. Never accepts secrets in arguments or revokes OneVU passkeys. Returns metadata only. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `confirm`, `replaceExisting`, `timeoutSeconds`.

`vutoolkit setup.enroll --json '<arguments>'` prints a JSON result. MCP tool `setup.enroll` on server `vutoolkit` returns the same result as `structuredContent`.

### setup.identity

Configure the account's non-secret Vanderbilt email and/or VUnetID in the native host vault. A VUnetID alone supplies its Vanderbilt sign-in address. Never accepts passwords or passkeys. Refuses to change an identity while an existing passkey is bound to another account.

Arguments: `email`, `vunetId`.

`vutoolkit setup.identity --json '<arguments>'` prints a JSON result. MCP tool `setup.identity` on server `vutoolkit` returns the same result as `structuredContent`.

### setup.prepare

Prepare a dedicated OneVU tab for the account holder to sign in. Normal setup may load the configured toolkit passkey; recovery=true deliberately does not load or retry the rejected key and requires the holder to use their usual sign-in method. Does not issue or change credentials. The visible page must match the configured student's email before enrollment. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `keepTab`, `recovery`, `timeoutSeconds`.

`vutoolkit setup.prepare --json '<arguments>'` prints a JSON result. MCP tool `setup.prepare` on server `vutoolkit` returns the same result as `structuredContent`.

### setup.run

Deterministic one-call Vanderbilt setup or explicit passkey recovery. Uses this host's configured identity and optional vaulted VANDERBILT_PASSWORD, first reusing an authenticated browser session. On first-time setup it enrolls and vault-verifies a new OneVU passkey, then establishes Vanderbilt and Microsoft sessions. status=partial means Vanderbilt is ready but Microsoft is not; do not claim full setup. Existing valid keys are reused, never rotated. recovery=true skips a rejected key and preserves it as a vault backup. With allowInteractiveVerification=false, setup does not submit a password or click a verification factor; OneVU may still require step-up for enrollment. Returns no credentials. Typed errors tell the caller what prerequisite or one-time verification is missing. Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).

Arguments: `confirm`, `recovery`, `allowInteractiveVerification`, `timeoutSeconds`.

`vutoolkit setup.run --json '<arguments>'` prints a JSON result. MCP tool `setup.run` on server `vutoolkit` returns the same result as `structuredContent`.

### setup.status

Check Vanderbilt account setup without returning credentials: configured identity, structural passkey validity, managed-browser availability and the next step. Structural validity does not prove OneVU accepts the key.

`vutoolkit setup.status --json '<arguments>'` prints a JSON result. MCP tool `setup.status` on server `vutoolkit` returns the same result as `structuredContent`.

### web

Open this tool's web app: serves the operations page and the MCP endpoint on a free local port, opens a browser there, and returns the URL.

`vutoolkit web --json '<arguments>'` prints a JSON result. MCP tool `web` on server `vutoolkit` returns the same result as `structuredContent`.

<!-- /tf:operations -->
