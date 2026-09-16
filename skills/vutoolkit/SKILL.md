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

The YES academic record: posted terms plus in-progress unposted courses. Fixture mode for development and tests; live mode rides the cached vanderbilt session through the aai OIDC dance (mints one via the OneVU ceremony over CDP when the vault is empty) — zero manual steps.

Arguments: `fixturePath`.

`vutoolkit record.fetch --json '<arguments>'` prints a JSON result. MCP tool `record.fetch` on server `vutoolkit` returns the same result as `structuredContent`.

### sessions.ensure

Zero-step auth: return the cached session for the IdP, or mint a fresh one over CDP and cache it — OneVU passkey ceremony for vanderbilt, Entra-carry (identifier-first + KMSI fallback) for microsoft. Secrets resolve from the OpenClaw vault (VANDERBILT_EMAIL, VANDERBILT_PASSKEY) or VUTOOLKIT_VU_EMAIL / VUTOOLKIT_PASSKEY_JSON / VUTOOLKIT_CDP_URL env overrides. The browser is driven in its own tab, so a shared managed browser is never disturbed.

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

Force re-mint: forget the cached session for the IdP and run its ceremony again (OneVU passkey over CDP, or the Microsoft Entra carry) — auth stays invisible even when a session goes stale or unhealthy.

Arguments: `idp`.

`vutoolkit sessions.refresh --json '<arguments>'` prints a JSON result. MCP tool `sessions.refresh` on server `vutoolkit` returns the same result as `structuredContent`.

### web

Open this tool's web app: serves the operations page and the MCP endpoint on a free local port, opens a browser there, and returns the URL.

`vutoolkit web --json '<arguments>'` prints a JSON result. MCP tool `web` on server `vutoolkit` returns the same result as `structuredContent`.

<!-- /tf:operations -->
