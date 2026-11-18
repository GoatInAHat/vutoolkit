# Remote vutoolkit on Railway

Runs vutoolkit as a remote MCP server (for a claude.ai custom connector or any MCP client) in one
container, with its own headless Chromium for the OneVU passkey ceremony and a second, separate
browser that the agent drives while signed in as the student. Nothing here needs OpenClaw.

## What the entrypoint does

`sh deploy/railway/start.sh`:

1. Starts headless Chromium on `127.0.0.1:9222` with its profile on the volume
   (`/data/chromium`), clearing the stale profile lock a restart or serverless sleep leaves behind,
   and restarts it if it exits.
2. When `openclaw` is not installed, puts `openclaw-shim.cjs` on `PATH` as `openclaw`. It answers
   only `openclaw secrets store get|set`, storing values in `/data/secrets/vault.json` (mode 0600)
   and falling back to the environment variable of the same name on `get`. This is how the
   passkey's sign counter and a newly enrolled passkey persist on the volume.
3. Runs `server.mjs`: the generated MCP handler on `$PORT` (bearer token required), `/healthz`,
   `sessions.open` withheld from MCP (raw cookies stay on the host; `request` and the browser
   still use them), the signed-in browser's `browser.*` tools, and, with `VUTOOLKIT_AUTO_SETUP=1`,
   the one-time setup on its own.

## The signed-in browser

`browser.mjs` runs Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp) server
in-process (pinned in `package.json` here) and offers its tools over the same endpoint as
`browser.navigate`, `browser.snapshot`, `browser.click` and so on. Before the first call, and at
most every 30 minutes, it loads vutoolkit's Vanderbilt and Microsoft sessions into that browser;
when a page lands on the OneVU or Microsoft sign-in page anyway, it re-mints that session with the
toolkit passkey and opens the page again. It launches its own Chromium (`VUTOOLKIT_BROWSER_EXECUTABLE`,
set by `start.sh`), never the ceremony browser, because Chromium switches off a tab's passkey helper
when another DevTools client detaches from it.

Not offered: the cookie and storage tools and `run_code_unsafe` (session values and code
execution stay on the server), tools whose output is a file on this server (screenshots, PDFs,
uploads), and test-harness controls (request mocking, offline mode, media emulation). Cookie and
authorization header lines are redacted from every result. Set `VUTOOLKIT_BROWSER=0` to turn the
browser off.

`VUTOOLKIT_BROWSER_PROBE=https://brightspace.vanderbilt.edu/d2l/home` checks a deploy: once the
server starts it opens that page in the browser and logs where it landed (origin, path and title
only) and whether that is a sign-in page.

## Service settings

- Build: Railpack, build command `npm run build && npm ci --prefix deploy/railway`.
- Start command: `sh deploy/railway/start.sh`.
- Healthcheck path: `/healthz`.
- Volume mounted at `/data`.
- Variables:
  - `RAILPACK_DEPLOY_APT_PACKAGES=chromium fonts-liberation`
  - `VUTOOLKIT_MCP_TOKEN`: a long random value; whatever sits in front (an OAuth proxy) sends it.
  - `VUTOOLKIT_DATA_DIR=/data/vutoolkit`, `VUTOOLKIT_CREDENTIAL_STORE=file`
  - `HOST=::` for Railway's private network.
  - `VUTOOLKIT_AUTO_SETUP=1` to run setup without an agent.

Do not expose this service publicly with only the bearer token; put an OAuth 2.1 proxy (for
example `ghcr.io/sigbit/mcp-auth-proxy`) in front on the private network.

## One-time Vanderbilt setup

1. Add `VANDERBILT_EMAIL` (your `@vanderbilt.edu` address) and, for this step only,
   `VANDERBILT_PASSWORD`, then deploy.
2. On start, auto-setup signs in, picks Okta Verify's push on OneVU's security-method chooser and
   waits up to five minutes. Approve the push on your phone. It then enrolls a passkey for this
   server alone and verifies it with a fresh sign-in. The deploy logs say `auto-setup: done`.
3. Remove `VANDERBILT_PASSWORD`. Later sign-ins use the passkey only.

Auto-setup tries at most twice per deployment (`VUTOOLKIT_AUTO_SETUP_ATTEMPTS`), at least ten
minutes apart, so a missed push never keeps paging your phone; redeploy to try again. Use a passkey
enrolled by this server rather than copying one from another host: two hosts sharing one key keep
separate sign counters.

`VUTOOLKIT_SETUP_TRACE=1` logs each step of the passkey enrollment page (headings, controls, form
error, and what kind of WebAuthn request OneVU made; never field values or key material).
`VUTOOLKIT_DEBUG_BROWSER=1` logs each browser page's origin, path and title as it changes. Do not
attach other DevTools clients to the setup tab while setup runs: Chromium switches off the tab's
passkey helper whenever any DevTools session on it disconnects.

