# vutoolkit

Universal toolkit for managing life as a Vanderbilt student — built for AI agents first, with [toolfactory](https://github.com/GoatInAHat/toolfactory).

## Core
Intentionally minimal: authentication and session management.

- **OneVU SSO** (Vanderbilt's Okta-backed SSO) via **passkey** (WebAuthn) — the programmatic path around interactive 2FA.
- Optional **password** for platforms that don't accept OneVU SSO (out of scope for core/CLI; available to agents that need it).
- Returns valid **Vanderbilt SSO** and **Microsoft** sessions; caches and injects them for any downstream service — browser or direct API.

## Surfaces
One operation module, shipped by toolfactory as: core library, OpenClaw plugin (agent tools), MCP server, CLI, OpenClaw Control UI widgets/web, and a Chrome extension for YES.

## Tools (roadmap)
1. **What-if grades calculator** — academic record from yes.vanderbilt.edu + JSON of expected in-progress grades → semester and cumulative GPA. Golden test: recomputed historical GPAs must match Vanderbilt's posted numbers before what-if output is trusted.
2. **YES browser extension** — full replacement for [VandyScheduler](https://github.com/quinton22/VandyScheduler) with 100% tested feature coverage; modifies cart, not enrollment.
3. **Degree planner** — prereq/degree graph from YES degree-audit + class-planner APIs, rendered as a d3 directed graph with weighted optimal paths; Rate My Professors metadata per node alongside official description/time/location. R&D: durable prereq parsing + graph ranking.

## Principles
- Tool operations are **read-only**; agents may write only where the account holder directs.
- Thin wrappers over live APIs — no friendly re-implementations that rot when routes change. Any agent can always hit the raw API with an injected session.
- Setup flow (last build step): user provides VUnetID + email (+ optional password) → guided passkey issuance → secrets land in the OpenClaw vault as SecretRefs.

## Secrets
All credentials live in the OpenClaw secret vault (working names: `VANDERBILT_VUNETID`, `VANDERBILT_EMAIL`, `VANDERBILT_PASSKEY`, `VANDERBILT_PASSWORD`). Never committed, never logged.

## Repo layout
- `docs/SPEC.md` — original project brief (Bennett, 2026-09-13).
- `research/VandyScheduler` — reference extension to replace (gitignored).

## Status
- [x] Spec captured, repo scaffolded
- [ ] Credentials extracted from old deployment → vault (coordination session running)
- [ ] toolfactory fitness review + operation-module layout
- [ ] Automated OneVU SSO login (passkey) against live account (read-only)
- [ ] SSO → Microsoft (Graph) session chain
- [ ] What-if GPA calculator + golden test
- [ ] Extension rewrite
- [ ] Setup flow
