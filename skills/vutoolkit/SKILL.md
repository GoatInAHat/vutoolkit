---
name: vutoolkit
description: Universal toolkit for Vanderbilt student life - OneVU SSO and
  passkey sessions, what-if grades, YES tools; built for AI agents first.
license: MIT
---

# vutoolkit

Explain here when an agent should reach for this tool and how to combine its operations.

<!-- tf:operations -->
## Operations

### gpa.verify

The golden anchor: recompute per-term GPAs from posted marks and compare against the numbers Vanderbilt posted. Run before trusting any what-if output. Defaults to the synthetic fixture; pass a live transcript to lock the real YES mapping.

Arguments: `transcript`.

`vutoolkit gpa.verify --json '<arguments>'` prints a JSON result. MCP tool `gpa.verify` on server `vutoolkit` returns the same result as `structuredContent`.

### grades.whatif

Pure GPA projection: apply hypothetical grades onto a transcript (replaces posted grades, fills unposted ones) and report per-term and cumulative GPAs.

Arguments: `transcript`, `hypotheticals`.

`vutoolkit grades.whatif --json '<arguments>'` prints a JSON result. MCP tool `grades.whatif` on server `vutoolkit` returns the same result as `structuredContent`.

### record.fetch

The YES academic record: posted terms plus in-progress unposted courses. Fixture mode for development and tests; live mode gated on credentials.

Arguments: `fixturePath`.

`vutoolkit record.fetch --json '<arguments>'` prints a JSON result. MCP tool `record.fetch` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.ensure

Zero-step auth: return the cached session for the IdP, or mint a fresh one via the OneVU passkey ceremony over CDP and cache it. Secrets resolve from the OpenClaw vault (VANDERBILT_EMAIL, VANDERBILT_PASSKEY) or VUTOOLKIT_VU_EMAIL / VUTOOLKIT_PASSKEY_JSON / VUTOOLKIT_CDP_URL env overrides. The browser is driven in its own tab, so a shared managed browser is never disturbed. Microsoft minting lands with the SSO-to-graph chain.

Arguments: `idp`.

`vutoolkit sessions.ensure --json '<arguments>'` prints a JSON result. MCP tool `sessions.ensure` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.forget

Drop a cached session: removes its row (metadata and values) from the session vault.

Arguments: `idp`.

`vutoolkit sessions.forget --json '<arguments>'` prints a JSON result. MCP tool `sessions.forget` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.ingest

Ingest a harvested browser cookie export into the session vault: keeps only cookies in the IdP's domain scope, stores values under the tool data dir (0600), and reports metadata only. The harvest itself is produced by the host browser outside this toolkit.

Arguments: `idp`, `sourcePath`.

`vutoolkit sessions.ingest --json '<arguments>'` prints a JSON result. MCP tool `sessions.ingest` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.list

Cached Vanderbilt SSO and Microsoft sessions: metadata only (idp, acquired, expiry, health). Session values never leave the vault.

`vutoolkit sessions.list --json '<arguments>'` prints a JSON result. MCP tool `sessions.list` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.open

Injection payload for a stored session: raw Cookie header, CDP Network.setCookie params, or Playwright storageState. Values resolve from the session vault fed by sessions.ingest; never logged, never echoed anywhere else.

Arguments: `idp`, `format`.

`vutoolkit sessions.open --json '<arguments>'` prints a JSON result. MCP tool `sessions.open` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.refresh

Run the OneVU passkey ceremony (CDP virtual authenticator holding the vaulted credential) and re-vault the fresh session. Credential material arrives via SecretRef — extracted or born-virtual, same contract.

Arguments: `idp`, `startUrl`, `secretRef`, `headless`.

`vutoolkit sessions.refresh --json '<arguments>'` prints a JSON result. MCP tool `sessions.refresh` on server `vutoolkit` returns the same result as `structuredContent`.

This operation needs browser: drive this host's own browser tools and pass what they return as arguments.

### web

Open this tool's web app: serves the operations page and the MCP endpoint on a free local port, opens a browser there, and returns the URL.

`vutoolkit web --json '<arguments>'` prints a JSON result. MCP tool `web` on server `vutoolkit` returns the same result as `structuredContent`.

<!-- /tf:operations -->
