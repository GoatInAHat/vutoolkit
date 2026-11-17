# Changelog

Notable user-facing changes are recorded here. Published versions and artifacts are listed in [GitHub Releases](https://github.com/GoatInAHat/vutoolkit/releases).

## Unreleased

## 0.5.2

- Keep waiting while Okta shows its "Haven't received a push notification yet?" hint; it sits in the form's error container but is not a rejection, and `setup.run` used to stop there with `OKTA_REJECTED` while the push was still pending.
- Fix passkey enrollment failing with `WebAuthn.getCredentials failed: The Virtual Authenticator Environment has not been enabled`. Chromium keeps one WebAuthn environment per frame and switches it off whenever any DevTools session on that frame disconnects; the Railway kit's page logger did exactly that every three seconds. Enrollment now switches the authenticator back on through its own session if it is lost before a credential exists, keeps a staged credential through a later loss, and reports `AUTHENTICATOR_LOST` only when it keeps disappearing.
- A stalled enrollment now ends with `ENROLLMENT_INCOMPLETE` inside the whole-call budget, naming the page it stopped on and the shape of any WebAuthn request OneVU made (never challenges or key material); `VUTOOLKIT_SETUP_TRACE=1` logs each change as it happens.
- `OKTA_REJECTED` now quotes OneVU's own error text (emails redacted), and CDP failures include the protocol's error message.
- Railway kit: `VUTOOLKIT_DEBUG_BROWSER=1` only reads the browser's target list and never attaches to a page.

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
