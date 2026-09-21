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

<!-- tf:install -->
## Install

[![Agent Skill](https://img.shields.io/badge/Agent_Skill-available-5B5BD6)](https://github.com/GoatInAHat/vutoolkit)

- **Agent Skill** — `npx skills add GoatInAHat/vutoolkit`
- **MCP server** — `npx -y vutoolkit mcp` [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=vutoolkit&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22vutoolkit%22%2C%22mcp%22%5D%7D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=vutoolkit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInZ1dG9vbGtpdCIsIm1jcCJdfQ==)
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout
- **Browser extension** — from a checkout: `npm --prefix hosts/browser install && npm --prefix hosts/browser exec --no -- wxt build`,
  then `chrome://extensions` → developer mode → Load unpacked → `hosts/browser/.output/chrome-mv3`
  (Firefox: `npm --prefix hosts/browser exec --no -- web-ext run`). Each GitHub Release attaches the
  store uploads `vutoolkit-0.2.0-chrome.zip`, `vutoolkit-0.2.0-firefox.zip`, `vutoolkit-0.2.0-edge.zip`. When Firefox signing credentials are configured, it also attaches a
  Mozilla-signed `.xpi`; the Chrome Web Store, Firefox Add-ons and Edge Add-ons listings appear once the release's
  submit step has each store's credentials. Then pair it: `npx -y vutoolkit mcp --http --pair`
  prints the `<url>#<token>` the extension's options page accepts.
- **Web app** — `npx -y vutoolkit mcp --http --open` serves the operations page beside the
  MCP endpoint on one port and opens it; over MCP or a skill, the `web` operation does the same and
  returns the URL.
- **npm package** — `npm install vutoolkit`

<!-- /tf:install -->
