# Privacy policy

This policy covers the vutoolkit browser extension (`hosts/browser`) submitted to the Chrome
Web Store, Firefox Add-ons, and Edge Add-ons, and the local vutoolkit kernel it talks to. It
describes what is collected, where it is stored, what is transmitted, and to whom — in terms of
the actual code paths below, not aspirational claims. See [SPEC.md](SPEC.md) for what the tool
does and [ACCEPTANCE.md](ACCEPTANCE.md) for what is live-verified versus still boundaryed.

## Summary

vutoolkit has no vendor-run backend and no analytics. The extension is a thin client: it reads
the Vanderbilt YES page you are already signed into, and talks to a vutoolkit kernel running as
a local process on **your own machine** (`vutoolkit mcp --http`, or an OpenClaw plugin install
you control). That kernel, not the extension developer, holds your Vanderbilt/Microsoft
credentials and sessions, and it is the only thing that talks to Vanderbilt's, Microsoft's, and
Rate My Professors' servers on your behalf. Nothing in this project sends your data to the
developer (GoatInAHat) or to any analytics or advertising service.

## What the extension itself collects and stores

The extension's manifest (`hosts/browser/wxt.config.ts`) requests exactly one permission,
`storage`, and `host_permissions` limited to `http://127.0.0.1/*` and `http://localhost/*` — it
cannot reach any non-local network address itself. Firefox's manifest additionally declares
`data_collection_permissions: { required: ["none"] }`, because nothing collected by the
extension leaves the browser for a developer-controlled destination.

Stored in `browser.storage.local` (persisted on disk by the browser, readable only by this
extension, cleared if you remove the extension or clear its site data):

| Key | Content | Why |
| --- | --- | --- |
| `endpoint` | The paired kernel URL (default `http://127.0.0.1:3000/mcp`) | Set once via `vutoolkit mcp --http --pair`; see `hosts/browser/utils/mcp.ts` |
| `onboarded` | `true`/`false` | Tracks whether first-run setup finished (`hosts/browser/entrypoints/background.ts`) |
| `yesSchedulerPreferences` | Your excluded courses/sections and free-time preferences for the schedule solver | Lets the scheduler persist your choices across page loads (`hosts/browser/entrypoints/yes.content.ts`) |
| `vuToolkitProfessorMappings` | Your chosen Rate My Professors match for an ambiguous professor name | Avoids re-querying Rate My Professors once you disambiguate a name |

Stored in `browser.storage.session` (in memory only, never written to disk, cleared when the
browser closes, and never readable by a content script):

| Key | Content | Why |
| --- | --- | --- |
| `token` | The pairing bearer token for your local kernel | Authorizes the extension's background worker to call your kernel; never sent anywhere except that paired `endpoint` |

None of the above is a Vanderbilt password, passkey, or session cookie — those never reach the
extension's storage. The extension does not use cookies, fingerprinting, or any third-party
script-injected tracking.

## What the local kernel collects and stores

The kernel (`src/`) runs as a process you control — either a standalone `vutoolkit` install or
an OpenClaw plugin on a gateway you administer. It, not the extension, is where your Vanderbilt
identity and sessions live:

- **Account identity you provide once during setup** (`src/sso/setup-operations.ts`): your
  VUnetID/email (non-secret) and, where supported, a passkey or password. These resolve from
  your own OpenClaw secret vault, or — for a standalone install — from local files at `0600`
  permissions (`src/vault/file-store.ts`, `src/vault/credential-store.ts`). The kernel never
  accepts these as plain call arguments; see `src/vault/index.ts`.
- **Session cookies for Vanderbilt SSO and Microsoft** (`sessions.ensure`, `sessions.refresh`,
  `sessions.ingest`, `src/vault/file-store.ts`): the raw `Cookie` header needed to reuse an
  authenticated session, scoped to `vanderbilt.edu` and Microsoft's identity/Graph domains.
  Stored the same way as account identity (native vault or local `0600` file), never logged.
- **Academic data fetched on your behalf, read-only**: your YES transcript and in-progress
  courses (`record.fetch`), Brightspace data (`brightspace.fetch`/`brightspace.api`), degree
  audit/planner data, and Microsoft Graph responses (`graph.call`) for the account you
  authenticated as. The kernel does not persist a separate copy of this data beyond normal
  in-process handling of the request that asked for it; it is not written to a database or
  shipped anywhere outside your own session storage described above.

No part of this project writes any of the above to a server operated by the developer. There is
no such server.

## What gets transmitted, and to whom

| Destination | What is sent | When |
| --- | --- | --- |
| Your local kernel (`127.0.0.1`/`localhost`, loopback only) | MCP requests with operation name and arguments (e.g. scraped YES page data for the scheduler, a pairing token for auth) | Every time the extension's background worker calls an operation (`hosts/browser/utils/mcp.ts`) |
| `yes.vanderbilt.edu`, Vanderbilt SSO (OneVU), Microsoft identity/Graph endpoints | Your own session cookies/credentials, to read your own academic record, GPA inputs, degree audit, and Graph identity | Only from the kernel, only for read operations; see [ACCEPTANCE.md](ACCEPTANCE.md) for what is live-verified. The current release never performs enrollment and blocks cart-mutation requests in its live suite. |
| `www.ratemyprofessors.com` (`src/yes/professors.ts`) | A professor name search query only | When the scheduler UI looks up a professor's public rating. No Vanderbilt credential, cookie, student name, or identifier is included in this request — confirmed by `tests/live.test.ts` and the function's own request body. |

Nothing is sent to the extension developer, to a vutoolkit-operated server, or to any
analytics, crash-reporting, or advertising service — none exists in this codebase (no telemetry
SDK, no third-party script, no remote logging call).

## Data protection

- Secrets (passkey, password) and session cookies are resolved through a native secret vault
  when running under OpenClaw, or local files restricted to your own OS user account (`0600`)
  for a standalone install — never through a plain call argument, and never echoed in logs or
  tool output (`src/vault/index.ts`, `src/vault/file-store.ts`).
- The extension's own pairing token lives only in `storage.session` — in memory, invisible to
  content scripts, gone when the browser closes (`hosts/browser/utils/mcp.ts`).
- The kernel listens on loopback only; the background worker is the only part of the extension
  that can reach it, and it authenticates every request with the pairing token.

## Your rights and controls

You control every credential and session this project handles, because it runs on infrastructure
you control:

- **Access/export**: `sessions.list` and `sessions.open` show what sessions exist and let you
  export them in cookie/CDP/Playwright form for your own use.
- **Deletion**: `sessions.forget` removes a stored session for an identity provider. Removing
  the extension, or clearing its site data from your browser's extension settings, deletes
  everything in `storage.local`/`storage.session` listed above. Removing or reconfiguring your
  OpenClaw vault entry, or deleting the standalone kernel's local store file, removes your
  stored credentials and session cookies.
- **No account on our side to delete**: because there is no developer-run server or account
  system, there is nothing held about you beyond what sits in your own browser profile and your
  own kernel install.

## Children's privacy

vutoolkit is built for currently-enrolled Vanderbilt University students authenticating with
their own VUnetID; it is not directed at children and is not usable without a Vanderbilt SSO or
Microsoft account.

## Changes to this policy

If the data this project collects, stores, or transmits changes, this document is updated in
the same pull request as the change, and the version history is visible in this repository's
git log.

## Contact

Questions about this policy or a data-handling concern: open an issue at
[github.com/GoatInAHat/vutoolkit](https://github.com/GoatInAHat/vutoolkit).
