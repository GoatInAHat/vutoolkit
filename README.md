# vutoolkit

**Vanderbilt authentication, GPA planning, degree graphs, and YES scheduling for AI agents.**

[![CI](https://github.com/GoatInAHat/vutoolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/GoatInAHat/vutoolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[Releases](https://github.com/GoatInAHat/vutoolkit/releases) · [Changelog](CHANGELOG.md) · [Original specification](docs/SPEC.md) · [Contributing](CONTRIBUTING.md)

vutoolkit connects an authorized student's agent to Vanderbilt OneVU, YES, and Microsoft Graph. A shared operation layer powers the CLI, MCP server, OpenClaw plugin, and web app through [Tool Factory](https://github.com/GoatInAHat/toolfactory).

This is an independent, community-developed project, not an official Vanderbilt University service.

## What works today

| Capability | Operations | Scope |
| --- | --- | --- |
| OneVU and Microsoft sessions | `sessions.ensure`, `sessions.refresh`, `sessions.list` | Passkey-based authentication, cached sessions, and liveness checks |
| Session interoperability | `sessions.ingest`, `sessions.open`, `sessions.forget` | Cookie, CDP, and Playwright formats for authorized clients |
| Academic record | `record.fetch` | Historical grades and current courses from YES |
| GPA planning | `gpa.verify`, `grades.whatif` | Compare calculated GPA with the official record before projecting hypothetical grades |
| Microsoft Graph | `graph.call` | Mail, calendar, profile, and other API resources accessible to the student's session |
| Degree and course data | `degree.audit`, `degree.graph`, `degree.options`, `courses.*` | Official YES requirements, course alternatives, prerequisite descriptions, and section metadata |
| Prerequisite planning | `planner.graph` | Directed AND/OR graph, completed/planned courses, weighted alternatives, explicit unknowns |
| Schedule planning | `scheduler.solve`, `scheduler.cartPlan` | Conflict-free combinations, lecture/lab components, free-time preferences, and cart-only diffs |
| Professor metadata | `professors.search` | Public Vanderbilt Rate My Professors candidates, preserving namesake ambiguity |
| Account setup | `setup.identity`, `setup.status`, `setup.prepare`, `setup.enroll` | Identity and sign-in preparation; consent-gated passkey enrollment implemented and fixture-tested, with first-time live issuance still unverified |
| Web interface | `web` | Interactive degree/prerequisite graph, course details, setup, and operation explorer |
| YES extension | Browser content script | Course/section preferences, schedule selection, bulk cart controls, and professor links; never enrollment |

See [the feature acceptance record](docs/ACCEPTANCE.md) for verified behavior and remaining limits. Official YES audits remain the degree authority. Prerequisite prose can be ambiguous, exhaustive searches can be large, and linked-section eligibility may need official confirmation; the toolkit reports uncertainty rather than silently treating these cases as valid.

## Quick start from source

Requires **Node.js 22.14 or later** and npm. OpenClaw installations require the Node version supported by their OpenClaw release.

```sh
git clone https://github.com/GoatInAHat/vutoolkit.git
cd vutoolkit
npm ci
npm run build
npm --prefix web ci
npm --prefix web run build
```

Try a credential-free GPA check, start an MCP server, or open the web interface:

```sh
node dist/toolfactory/cli.js gpa.verify --json '{}'
node dist/toolfactory/cli.js mcp
node dist/toolfactory/cli.js mcp --http --open
```

The default GPA fixture is synthetic. It validates the calculation path, **not** your live Vanderbilt record. For a real projection, call `record.fetch`, pass its transcript to `gpa.verify`, then supply that same transcript and your hypothetical grades to `grades.whatif`.

### Authentication

For an existing OpenClaw account setup, vutoolkit resolves `VANDERBILT_EMAIL` and `VANDERBILT_PASSKEY` from that instance's secret vault. A local Chromium CDP endpoint is required when a fresh passkey ceremony is needed; the default integration starts OpenClaw's managed headless browser. Existing healthy sessions are reused.

Standalone deployments can inject `VUTOOLKIT_VU_EMAIL`, `VUTOOLKIT_PASSKEY_JSON`, and optionally `VUTOOLKIT_CDP_URL` through their own secret manager. Do not put secret values in chat, repository files, or command-line arguments.

For first-time OpenClaw setup, open the **Setup** panel (or call `setup.identity` and `setup.prepare`). Complete the first OneVU sign-in in the managed browser, then explicitly approve `setup.enroll` to create and vault a toolkit passkey. This account-security write is separate from ordinary read-only verification. A configured key is preserved, not automatically rotated if sign-in fails.

Each person needs their **own** Vanderbilt account and passkey. Use separate host secret vaults and `VUTOOLKIT_DATA_DIR` values when serving multiple people; do not copy one student's sessions to another person's installation.

### OpenClaw

From the built checkout:

```sh
openclaw plugins install --link hosts/openclaw
openclaw plugins inspect vutoolkit --runtime --json
```

Reload the gateway using your deployment's normal lifecycle to activate the plugin. After rebuilding a linked checkout, `npm run relink` refreshes its installed snapshot; a gateway reload is still required.

## Data and permissions

Academic-record reads and GPA calculations do not change enrollment. The browser extension changes the YES **cart only** when you choose its cart controls; it never submits enrollment. `setup.enroll` adds an account credential only after explicit confirmation and never replaces an existing toolkit key. `graph.call` is a general Microsoft Graph client: **POST, PATCH, PUT, and DELETE can change the real account** and should only be used when the account holder requests those actions.

Passkey material is resolved from the host's secret store. Session cookies and Graph tokens are cached locally in permission-restricted files. Most session operations return metadata, but `sessions.open` intentionally returns usable authentication material; send that payload only to the authorized client and keep it out of logs and public artifacts. See [Security](SECURITY.md).

## Development and verification

```sh
npm test
npm run build
npx toolfactory check
npx toolfactory validate
```

Tests using fixtures do not substitute for authenticated checks. Live tests are account-specific and must verify both identity and official GPA totals without publishing private records. [Release engineering](docs/RELEASING.md) describes the release gates and npm trusted publishing.

On an account-configured host, run `npm run test:live` to opt into the Tool Factory live-test tier using that host's existing vault. Ordinary `npm test` skips the authenticated suite unless live mode is explicitly enabled.

| Path | Purpose |
| --- | --- |
| `src/ops.ts` | Agent-facing operation definitions |
| `src/sso/`, `src/vault/`, `src/graph/` | Authentication, session storage, and Graph access |
| `src/yes/`, `src/gpa/` | Academic-record parsing and GPA calculations |
| `web/`, `hosts/` | Web app and host integrations |
| `dev.toolfactory/tool.json` | Tool Factory surface and test configuration |
| `plugin.json` | Authoritative package identity and version |

## Distribution

The generated commands below describe the selected distribution surfaces. Registry availability is determined by a successful published release; a generated install command alone does not establish that a package or store listing exists.

<!-- tf:install -->
## Install

[![Agent Skill](https://img.shields.io/badge/Agent_Skill-available-5B5BD6)](https://github.com/GoatInAHat/vutoolkit)

- **Agent Skill** — `npx skills add GoatInAHat/vutoolkit`
- **MCP server** — `npx -y vutoolkit mcp` [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=vutoolkit&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22vutoolkit%22%2C%22mcp%22%5D%7D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=vutoolkit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInZ1dG9vbGtpdCIsIm1jcCJdfQ==)
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout; published: `openclaw plugins install clawhub:openclaw-plugin-vutoolkit`
- **Browser extension** — from a checkout: `npm --prefix hosts/browser install && npm --prefix hosts/browser exec --no -- wxt build`,
  then `chrome://extensions` → developer mode → Load unpacked → `hosts/browser/.output/chrome-mv3`
  (Firefox: `npm --prefix hosts/browser exec --no -- web-ext run`). Each GitHub Release attaches the
  store uploads `vutoolkit-0.3.0-chrome.zip`, `vutoolkit-0.3.0-firefox.zip`, `vutoolkit-0.3.0-edge.zip`. When Firefox signing credentials are configured, it also attaches a
  Mozilla-signed `.xpi`; the Chrome Web Store, Firefox Add-ons and Edge Add-ons listings appear once the release's
  submit step has each store's credentials. Then pair it: `npx -y vutoolkit mcp --http --pair`
  prints the `<url>#<token>` the extension's options page accepts.
- **Web app** — `npx -y vutoolkit mcp --http --open` serves the operations page beside the
  MCP endpoint on one port and opens it; over MCP or a skill, the `web` operation does the same and
  returns the URL.
- **npm package** — `npm install vutoolkit`

<!-- /tf:install -->
