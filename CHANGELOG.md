# Changelog

Notable user-facing changes are recorded here. Published versions and artifacts are listed in [GitHub Releases](https://github.com/GoatInAHat/vutoolkit/releases).

## Unreleased

## 0.7.1

- Railway kit: `mail.folders` lists only mail folders. It listed the calendar, contacts, tasks, notes and Yammer folders too, because it kept every well-known folder.
- Build: move to toolfactory 0.4.12, so the web scaffold drift check passes again on Node 24.

## 0.7.0

Outlook mail and calendar as tools, on Outlook on the web's own service and vutoolkit's existing sign-in (no Graph app, no new OAuth client).

- Railway kit: add `mail.search`, `mail.read`, `mail.folders` and `calendar.view`, with flat results and paging behind a cursor. `mail.search` filters one folder by words in the subject or body, sender, unread and received dates; `mail.read` returns a message's text and attachment names without marking it read; `calendar.view` lists events with offsets, location, organizer, response and meeting link.
- Railway kit: add `owa.actions`, `owa.describe` and `owa.call` for every other Exchange action. The catalog is generated (`scripts/owa-catalog.mjs`) from Microsoft's published EWS protocol schemas (73 operations, 718 types) and Microsoft's EWS reference (95 operations, including Inbox rules, out-of-office, availability and mail tips), plus the actions only Outlook on the web uses, such as `GetCalendarView`. Each action is marked read or write; an action the catalog does not know counts as a write. `owa.describe` gives the request fields, the types they use, the JSON conventions and an example body, and shows the request shape Outlook's own page sent for that action when the browser has seen one (structure only, no content).
- Writes through `owa.call` are on by default and act on the real mailbox. Set `VUTOOLKIT_OWA_WRITES=0` to refuse write and unknown actions; `VUTOOLKIT_OWA=0` turns the Outlook tools off.
- The token is the one Outlook's page already holds in the signed-in browser. When none is fresh, Outlook is opened in a background tab of that browser (signed in again in the background if Microsoft asks), its token taken from its own request and the tab closed; a 401 gets one retry on a fresh token. The token stays on the server and never appears in a result.

## 0.6.2

- Fix every `request` that got a 401 from a Microsoft 365 host re-minting the Microsoft session and still returning 401. 0.6.1 judged the session by a silent sign-in with the stored cookies, but Microsoft's sign-in service answers "no user is signed in" (AADSTS50058) for those cookies even seconds after a successful mint, so the check called every session dead. The check is gone: `sessions.ensure` re-mints a Microsoft session past its two-minute grace period as 0.6.0 did, and a 401 is retried once on a fresh session only when the request went out on an older one. A 401 on a fresh session comes back with the trace line saying the endpoint wants an OAuth bearer token.
- `browser.navigate` on Outlook and the other Microsoft 365 apps now returns the page as it settled (the signed-in inbox) instead of the empty "Outlook" shell it first loaded.

## 0.6.1

- Fix the signed-in browser landing on Microsoft's sign-in page for Outlook while `sessions.list` said the Microsoft session was healthy. Outlook on the web signs in with tokens its page keeps in local storage, and its page loads first and only redirects to sign-in a few seconds later, so the browser never noticed and the cookies it was given could not sign it in. The browser now waits for such a page to settle, finishes Microsoft's sign-in itself in the background (account tile, identifier, OneVU federation, "Stay signed in?"; never a password), minting OneVU with the toolkit passkey when the federation hop needs it, and opens the page again. Reloading the stored sessions no longer wipes the browser's own app sign-ins and local storage; only the sign-in hosts' cookies are renewed.
- `sessions.ensure` judges a cached Microsoft session by a live check (a silent OpenID Connect sign-in for Outlook with the stored cookies, nothing redeemed) instead of re-minting it after two minutes regardless, and a session that fails a live check stops reading as healthy in `sessions.list`.
- `request`: a 401 from a Microsoft 365 host now checks the Microsoft session live; when Microsoft no longer accepts it, the session is re-minted and the request sent once more. When the session is live, the 401 is the endpoint's own answer: Outlook REST, Microsoft Graph and Outlook's service calls want an OAuth bearer token, which a signed-in session's cookies cannot supply, and the trace now says so. Read mail in the signed-in browser.

## 0.6.0

The tool surface now gives the agent the signed-in session itself instead of per-site wrappers.

- Add `request`: one HTTP request to any Vanderbilt (`*.vanderbilt.edu`) or Microsoft 365 endpoint as the signed-in student. The stored sessions ride every sign-in hop (OneVU/Okta, Entra, SAML and OIDC form posts, redirect stubs), a refused session is re-minted with the toolkit passkey and the request retried once, and cookie values never appear in the result. It replaces `brightspace.fetch` and `brightspace.api` (use Brightspace's D2L Valence API directly) and `outlook.inbox`.
- Railway kit: a browser signed in to Vanderbilt and Microsoft 365 for the agent. Microsoft's Playwright MCP server runs in-process with its own Chromium and its tools are offered as `browser.*` on the same endpoint; vutoolkit loads its sessions into it and re-mints one when a page lands on a sign-in page. Tools that expose cookies or storage, run arbitrary code, or write files only the server can read are not offered.
- `record.fetch` now returns `verification` (recomputed against Vanderbilt's posted term and cumulative GPAs) with the transcript, and `grades.whatif` reads the live record when no transcript is passed. `gpa.verify` and `record.fetch`'s `fixturePath` are removed.
- `sessions.ensure` takes `force: true` in place of `sessions.refresh`.
- YES stays read-only: `request` and the Railway browser refuse enrollment and cart or planner changes on YES hosts. SharePoint hosts are reachable through `request`. A non-GET request is sent again after a sign-in only when the sign-in actually intercepted it, never after a plain redirect.
- Remove `scheduler.cartPlan` (a pure diff the agent can compute; the YES extension keeps its own cart logic), the Brightspace client, the Outlook inbox reader, the leftover Microsoft Graph credential kind, and the skill guidance for Graph tools that no longer exist. The skill now says which tool to use for what.

## 0.5.2

- Keep waiting while Okta shows its "Haven't received a push notification yet?" hint; it sits in the form's error container but is not a rejection, and `setup.run` used to stop there with `OKTA_REJECTED` while the push was still pending.
- Fix passkey enrollment failing with `WebAuthn.getCredentials failed: The Virtual Authenticator Environment has not been enabled`. Chromium keeps one WebAuthn environment per frame and switches it off whenever any DevTools session on that frame disconnects; the Railway kit's page logger did exactly that every three seconds. Enrollment now switches the authenticator back on through its own session if it is lost before a credential exists, keeps a staged credential through a later loss, and reports `AUTHENTICATOR_LOST` only when it keeps disappearing.
- Handle OneVU's "Set up security methods" list that follows the enrollment step-up: pick only the Security Key or Biometric row (at most twice, never another method), then press its enrollment screen's Set up control (a button or a link-style control, pressed again once only if no WebAuthn request followed within 15 seconds); the screen is now recognized by its text as well as Okta's classic form heading.
- A stalled enrollment now ends with `ENROLLMENT_INCOMPLETE` inside the whole-call budget, naming the page it stopped on and the shape of any WebAuthn request OneVU made (never challenges or key material); `VUTOOLKIT_SETUP_TRACE=1` logs each change as it happens.
- `OKTA_REJECTED` now quotes OneVU's own error text (emails redacted), and CDP failures include the protocol's error message.
- Railway kit: `VUTOOLKIT_DEBUG_BROWSER=1` only reads the browser's target list and never attaches to a page.
- Fix the release workflow, which still packaged and published 0.4.5 file names (so 0.5.1 never published). It is kept by hand for ClawHub's `id-token: write` permissions and had stopped following `plugin.json`; it is regenerated for this version with those permissions kept.

## 0.5.1

- Fix `setup.run` stalling on OneVU's "Verify it's you with a security method" chooser: it now picks Okta Verify's push (at most three clicks, only when interactive verification is allowed), so the holder gets a push to approve instead of a silent five-minute wait. The same applies to a step-up during passkey enrollment.
- Add `deploy/railway/`, a container kit for running vutoolkit as a remote MCP server: headless Chromium with lock recovery, a file-backed stand-in for the `openclaw secrets` CLI on the volume, `sessions.open` withheld over MCP, a `/healthz` route, and an opt-in auto-setup (`VUTOOLKIT_AUTO_SETUP=1`) that runs the one-time passkey enrollment on deploy with no agent involved.

## 0.4.3

- Handle Microsoft's Vanderbilt federation confirmation during sign-in, with exact-origin and account checks, bounded retries, and live session verification.
- Support OpenClaw's native vault for cached SSO sessions and Microsoft Graph tokens while preserving the standalone file-backed mode.
- Add regression coverage for confirmation pages, changed or disabled controls, repeated prompts, and native credential-cache behavior.

## 0.4.1

- Fix Microsoft session health checks to verify the stored cookies through a silent Microsoft Graph token and read-only `/me` request, instead of the obsolete Outlook redirect check.
- Reject Graph paths that normalize outside the documented `/v1.0/` API root before obtaining an access token or sending a request.
- Clarify v0.4.0 registry availability, scan status, and the distinction between installed source and verified live gateway activation.

## 0.4.0

- Deterministic `setup.run`: reuse browser authentication, automate configured identity/password steps, enroll and vault a toolkit passkey, and return actionable prerequisite errors.
- Explicit non-interactive mode for reusing an account session without submitting password or verification controls; server-required step-up is returned as an actionable error.
- Browser profile selection follows compatible host defaults or explicit endpoints; recovery never starts an unrelated browser for a custom endpoint.
- One-action setup panel and recovery-safe account matching, credential staging, and previous-key preservation.
- Official requirement-path ranking and clearer incomplete-search reporting.

## 0.3.0 (release candidate)

### Added

- Official YES degree-audit, requirement-alternative, course-catalog, and section-data operations.
- Interactive degree graph with prerequisite branches, ranked alternatives, course details, and professor metadata.
- Schedule solver with lecture/lab components, course and section exclusions, preferred free times, and explicit uncertainty reporting.
- YES browser extension with persisted preferences, schedule selection, bulk cart controls, and Rate My Professors links. Enrollment remains untouched.
- Guided account identity, setup status, and sign-in preparation, plus consent-gated passkey enrollment that preserves existing keys.
- An opt-in Tool Factory live-test tier and production browser acceptance with synthetic mutation fixtures.
- ESM library exports, release documentation, contributor guidance, and security reporting instructions.

### Fixed

- Official cumulative GPA verification and failed-course GPA-hour handling.
- Incomplete schedules when every section of a required course was excluded.
- Stale-term cart selection and extension-injected text leaking into parsed course metadata.
- Release packaging and host dependency metadata; development tests and old package archives are excluded from the npm payload.

### Verification limits

See [feature acceptance](docs/ACCEPTANCE.md) for release-specific evidence. Synthetic cart and passkey tests do not establish live mutation acceptance. Browser-store listings and registry publication are tracked separately from generated surface availability.
