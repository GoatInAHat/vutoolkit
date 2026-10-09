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
| Account setup | `setup.run`, `setup.identity`, `setup.status` | Deterministic one-call setup, session reuse, vaulted password support, and explicit recovery; see acceptance evidence |
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

Call **`setup.run({"confirm":true})`** once after configuring the student's identity. Setup reuses the selected browser's signed-in session, or enters the configured identity and optional `VANDERBILT_PASSWORD` from the host vault. OneVU may require a one-time phone approval. The toolkit handles the login and enrollment steps deterministically; an LLM does not drive the browser.

First-time setup enrolls a dedicated toolkit passkey and verifies its vault storage and OneVU acknowledgement. Session cookies support ordinary requests but are not a substitute for that durable credential. Known-rejected keys require explicit `recovery:true`; the previous key is preserved in the host vault. `allowInteractiveVerification:false` uses existing authentication only, without submitting a password or initiating verification.

Configure non-secret identity with `setup.identity` or vault entries `VANDERBILT_EMAIL` / `VANDERBILT_VUNETID`. Store passwords through the host's secret-entry UI, never chat, repository files, or command arguments. If no password is configured, `setup.prepare` opens a manual sign-in tab; rerun `setup.run` after signing in. Missing prerequisites and verification requirements return named errors, not a request for an agent to improvise login steps.

Browser selection: an explicit `VUTOOLKIT_CDP_URL` takes precedence, then `VUTOOLKIT_BROWSER_PROFILE`, then the host's compatible configured default. An incompatible implicit default may fall back to OpenClaw's managed profile. Explicit remote/custom endpoints never start an unrelated browser. Passkey enrollment requires full Chromium CDP/WebAuthn support, not merely a browser UI or extension relay.

Standalone deployments can inject `VUTOOLKIT_VU_EMAIL`, `VUTOOLKIT_PASSKEY_JSON`, and `VUTOOLKIT_CDP_URL` through their own secret manager. Existing healthy sessions are reused.

Each person needs their **own** Vanderbilt account and passkey. Use separate host secret vaults and `VUTOOLKIT_DATA_DIR` values when serving multiple people; do not copy one student's sessions to another person's installation.

### Credential cache storage

Standalone deployments retain 0600 file storage by default. On OpenClaw, configure
`plugins.entries.vutoolkit.config.VUTOOLKIT_CREDENTIAL_STORE` to `openclaw`; native CLI/MCP
calls on that host must also set `VUTOOLKIT_CREDENTIAL_STORE=openclaw` and the same canonical
`VUTOOLKIT_DATA_DIR` as the plugin. This is an explicit host setting, not a global environment
change made by importing the library. Unknown modes and unavailable native vaults fail closed,
without falling back to plaintext.

The native backend stores session cookies and Graph tokens in readable `env`-kind JSON
envelopes like the existing passkey adapter. Values travel over stdin, never command arguments,
and every write is verified by exact readback. Entry names are scoped by data-directory path.
Each IdP has its own entry, so an update or forget for Microsoft cannot overwrite a concurrent
Vanderbilt update. Same-IdP refreshes remain last-writer-wins, as in the previous file backend;
quiesce credential writers during migration. Never print a bare vault listing: readable entries
contain credentials. The native vault's 64 KiB per-entry limit is enforced before writes.

An existing `sessions.vault.json` or `graph-token.json` needs a deliberate cutover. Stop or
finish toolkit credential writers, then invoke the exported
`migrateCredentialCaches(dataDir)` from `dist/vault/credential-store.js` inside the trusted host
process. It splits the legacy session envelope into per-IdP entries, verifies vault readback,
rejects a conflicting existing vault value or a source
changed during migration, returns only names/status, and leaves originals intact. Complete a
native read/authentication proof before securely retiring the originals. Never switch an old
file-backed process back on after retirement; rollback must first restore current vault
contents to its old backend securely. Do not treat an earlier cache snapshot as current auth.

### OpenClaw

From the built checkout:

```sh
openclaw plugins install --link hosts/openclaw
openclaw plugins inspect vutoolkit --runtime --json
```

On current OpenClaw, plugin install/link applies the plugin without a gateway restart. After rebuilding a linked checkout, refresh its installed core snapshot with `npm run relink`; edited source can be applied with `openclaw plugins reload vutoolkit --wait --json`. Verify the running plugin after either path.

## Data and permissions

Academic-record reads and GPA calculations do not change enrollment. The browser extension changes the YES **cart only** when you choose its cart controls; it never submits enrollment. `setup.run` and `setup.enroll` add an account credential only with authorization; explicit recovery preserves the previous key before promoting its replacement. `graph.call` is a general Microsoft Graph client: **POST, PATCH, PUT, and DELETE can change the real account** and should only be used when the account holder requests those actions.

Passkey material is resolved from the host's secret store. Session cookies and Graph tokens use the configured native-vault or permission-restricted-file backend described above. Most session operations return metadata, but `sessions.open` intentionally returns usable authentication material; send that payload only to the authorized client and keep it out of logs and public artifacts. See [Security](SECURITY.md).

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

**v0.4.0 availability (checked 2026-09-27):** [GitHub release downloads](https://github.com/GoatInAHat/vutoolkit/releases/tag/v0.4.0) and the ClawHub skill/native package are published. The native package is flagged **suspicious** by ClawHub's scanner; publication is not a clean security verdict. **npm is not published yet**, so the `npx -y vutoolkit` and `npm install vutoolkit` commands below are not available. Use the [source installation](#quick-start-from-source) until the first npm publish and trusted-publisher configuration are complete.

The generated commands below describe the selected distribution surfaces, not proof that every registry or browser-store listing is available. See [release acceptance](docs/ACCEPTANCE.md) for verified behavior and remaining limits.

<!-- tf:install -->
## Install

[![Agent Skill](https://img.shields.io/badge/Agent_Skill-available-5B5BD6)](https://github.com/GoatInAHat/vutoolkit)

- **Agent Skill** — `npx skills add GoatInAHat/vutoolkit`
- **MCP server** — `npx -y vutoolkit mcp` [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=vutoolkit&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22vutoolkit%22%2C%22mcp%22%5D%7D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=vutoolkit&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInZ1dG9vbGtpdCIsIm1jcCJdfQ==)
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout; published: `openclaw plugins install clawhub:openclaw-plugin-vutoolkit`
- **Browser extension** — from a checkout: `npm --prefix hosts/browser install && npm --prefix hosts/browser exec --no -- wxt build`,
  then `chrome://extensions` → developer mode → Load unpacked → `hosts/browser/.output/chrome-mv3`
  (Firefox: `npm --prefix hosts/browser exec --no -- web-ext run`). Each GitHub Release attaches the
  store uploads `vutoolkit-0.4.2-chrome.zip`, `vutoolkit-0.4.2-firefox.zip`, `vutoolkit-0.4.2-edge.zip`. When Firefox signing credentials are configured, it also attaches a
  Mozilla-signed `.xpi`; the Chrome Web Store, Firefox Add-ons and Edge Add-ons listings appear once the release's
  submit step has each store's credentials. Then pair it: `npx -y vutoolkit mcp --http --pair`
  prints the `<url>#<token>` the extension's options page accepts.
- **Web app** — `npx -y vutoolkit mcp --http --open` serves the operations page beside the
  MCP endpoint on one port and opens it; over MCP or a skill, the `web` operation does the same and
  returns the URL.
- **npm package** — `npm install vutoolkit`

<!-- /tf:install -->
