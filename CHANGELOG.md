# Changelog

Notable user-facing changes are recorded here. Published versions and artifacts are listed in [GitHub Releases](https://github.com/GoatInAHat/vutoolkit/releases).

## Unreleased

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
