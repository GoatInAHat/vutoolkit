// Remote MCP server for vutoolkit in a container (Railway). Serves the generated MCP handler on
// $PORT with bearer-token auth, a /healthz route for the platform, a signed-in browser (browser.mjs)
// and, when enabled, runs the one-time Vanderbilt setup by itself so no agent has to drive it.
// See README.md.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);
const log = (message) => console.error(`[vutoolkit] ${message}`);
const { operations } = await import(new URL("dist/ops.js", root).href);
const { context } = await import(new URL("dist/toolfactory/config.js", root).href);

// The signed-in browser's tools join the operation list before the MCP handler reads it.
if (process.env.VUTOOLKIT_BROWSER !== "0") {
  try {
    const { browserOperations } = await import("./browser.mjs");
    const { configuredEmail, ensureSession } = await import(new URL("dist/sso/ensure.js", root).href);
    const browserSession = await import(new URL("dist/sso/browser-session.js", root).href);
    const { vaultStore } = await import(new URL("dist/http/with-session.js", root).href);
    const { z } = createRequire(new URL("package.json", root))("zod");
    const ctx = context();
    const browser = await browserOperations({
      z, ensureSession, browserSession, email: () => configuredEmail(), store: () => vaultStore(ctx), dataDir: ctx.dataDir, log,
    });
    operations.push(...browser);
    log(`browser: ${browser.length} tools ready`);
    // Outlook mail and calendar on Outlook on the web's own service, with the browser's token.
    if (process.env.VUTOOLKIT_OWA !== "0" && browser.owa) {
      const { owaOperations } = await import(new URL("dist/owa/operations.js", root).href);
      const writes = !["0", "false", "off", "no"].includes(String(process.env.VUTOOLKIT_OWA_WRITES ?? "1").toLowerCase());
      const owa = owaOperations({
        transport: browser.owa,
        recorded: (action) => browser.owa.recorded(action),
        writes,
        timeZone: process.env.VUTOOLKIT_OWA_TIMEZONE || undefined,
      });
      operations.push(...owa);
      log(`owa: ${owa.length} tools ready (writes ${writes ? "on" : "off"})`);
    }
  } catch (error) {
    log(`browser: unavailable (${error?.message ?? error}); serving without it`);
  }
}
const { handler } = await import(new URL("dist/toolfactory/mcp.js", root).href);
const token = process.env.VUTOOLKIT_MCP_TOKEN;
if (!token) {
  log("VUTOOLKIT_MCP_TOKEN is not set; refusing to serve an unauthenticated MCP endpoint.");
  process.exit(1);
}

// Raw session material stays on this host: sessions.open (cookie headers, CDP cookies) is not
// offered over MCP here. The fetch tools still use the sessions server-side.
const hidden = new Set((process.env.VUTOOLKIT_MCP_HIDE ?? "sessions.open").split(",").map((s) => s.trim()).filter(Boolean));
for (const op of operations) if (hidden.has(op.name)) op.requires = [...(op.requires ?? []), "user-input"];

const mcp = handler({ token, env: false });
const port = Number(process.env.PORT ?? 8080);
createServer((req, res) => ((req.url ?? "").startsWith("/healthz") ? res.end("ok") : mcp(req, res)))
  .listen(port, process.env.HOST ?? "::", () => log(`MCP listening on ${port}; hidden over MCP: ${[...hidden].join(", ") || "none"}`));

const op = (name) => operations.find((o) => o.name === name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-time setup without an agent: with VUTOOLKIT_AUTO_SETUP=1, an identity configured and no
 * toolkit passkey yet, run setup.run (which sends one Okta Verify push for the holder to approve).
 * Bounded per deployment: at most VUTOOLKIT_AUTO_SETUP_ATTEMPTS tries, at least 10 minutes apart,
 * so a missed push or a changed page cannot keep paging the phone.
 */
async function autoSetup() {
  if (process.env.VUTOOLKIT_AUTO_SETUP !== "1") return;
  const ctx = context();
  const stateFile = join(ctx.dataDir, "auto-setup.json");
  const deployment = process.env.RAILWAY_DEPLOYMENT_ID ?? "local";
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* first run */ }
  if (state.deployment !== deployment) state = { deployment, attempts: 0 };
  const save = () => { mkdirSync(ctx.dataDir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); };
  const maxAttempts = Number(process.env.VUTOOLKIT_AUTO_SETUP_ATTEMPTS ?? 2);

  let status;
  for (let i = 0; i < 12; i++) {
    status = await op("setup.status").handler({}, ctx);
    if (status.browserAvailable) break;
    await sleep(5000);
  }
  if (status.passkeyConfigured && status.passkeyValid) {
    log("auto-setup: a toolkit passkey is configured; nothing to set up.");
    if (process.env.VANDERBILT_PASSWORD) log("auto-setup: VANDERBILT_PASSWORD is no longer needed; remove it from the service variables.");
    return;
  }
  if (!status.identityConfigured) return log("auto-setup: set VANDERBILT_EMAIL (or VANDERBILT_VUNETID) to enable setup.");
  if (!status.browserAvailable) return log("auto-setup: Chromium is not reachable; setup skipped.");
  if (state.attempts >= maxAttempts) return log(`auto-setup: ${state.attempts} attempts already made for this deployment; redeploy to try again.`);
  if (state.lastAt && Date.now() - state.lastAt < 10 * 60_000) return log("auto-setup: last attempt was under 10 minutes ago; waiting.");

  state.attempts += 1;
  state.lastAt = Date.now();
  save();
  log(`auto-setup: attempt ${state.attempts}. Approve the Okta Verify push for Vanderbilt on your phone.`);
  try {
    const result = await op("setup.run").handler({ confirm: true, recovery: false, allowInteractiveVerification: true, timeoutSeconds: 420 }, ctx);
    state.result = `${result.status}/${result.passkey}`;
    save();
    log(`auto-setup: done (${result.status}, passkey ${result.passkey}, Microsoft ${result.microsoftSession}).`);
    if (process.env.VANDERBILT_PASSWORD) log("auto-setup: remove VANDERBILT_PASSWORD from the service variables now; it is not needed again.");
  } catch (error) {
    state.result = error?.code ?? "ERROR";
    save();
    log(`auto-setup: failed with ${error?.code ?? "ERROR"}: ${error?.message ?? error}`);
  }
}

/**
 * VUTOOLKIT_DEBUG_BROWSER=1 logs each page's origin, path and title as it changes (no query
 * strings). It reads only the target list and never attaches to a page: Chromium disables a
 * frame's WebAuthn environment whenever any DevTools session on it detaches, which would take the
 * passkey helper away from setup and sign-in.
 */
function browserLog() {
  if (process.env.VUTOOLKIT_DEBUG_BROWSER !== "1" || !process.env.VUTOOLKIT_CDP_URL) return;
  let last = "";
  setInterval(async () => {
    try {
      const list = (await (await fetch(new URL("/json/list", process.env.VUTOOLKIT_CDP_URL))).json()).filter((t) => t.type === "page");
      const pages = list.map((t) => {
        let where = "";
        try { const u = new URL(t.url); where = u.origin === "null" ? u.href : u.origin + u.pathname; } catch { where = "?"; }
        return `${where} [${String(t.title ?? "").slice(0, 60)}]`;
      }).join(" | ");
      if (pages !== last) { last = pages; log(`browser: ${pages}`); }
    } catch { /* browser restarting */ }
  }, 3000).unref();
}

/**
 * VUTOOLKIT_BROWSER_PROBE=<url> opens that page in the signed-in browser once the server starts and
 * logs only where it landed (origin, path, title) and whether that is a sign-in page: a deploy check
 * that the sessions load and re-mint, without an MCP client.
 */
async function browserProbe() {
  const url = process.env.VUTOOLKIT_BROWSER_PROBE;
  const navigate = op("browser.navigate");
  if (!url || !navigate) return;
  try {
    const { text } = await navigate.handler({ url }, context());
    const landed = /Page URL: (\S+)/.exec(text)?.[1] ?? "";
    const title = (/Page Title: (.*)/.exec(text)?.[1] ?? "").trim().slice(0, 80);
    const where = (() => { try { const u = new URL(landed); return { host: u.hostname, path: u.origin + u.pathname }; } catch { return { host: "", path: "?" }; } })();
    const signIn = ["onevu.vanderbilt.edu", "login.microsoftonline.com", "login.microsoft.com"].includes(where.host);
    log(`browser probe: ${signIn ? "NOT signed in" : "signed in"}: ${where.path} [${title}]`);
    // The probe's tab is its own; close it rather than leave it idle.
    const tab = /### Tab\n- (t\d+)/.exec(text)?.[1];
    if (tab) await op("browser.tabs")?.handler({ action: "close", tab }, context()).catch(() => {});
  } catch (error) {
    log(`browser probe: failed: ${String(error?.message ?? error).split("\n")[0].slice(0, 200)}`);
  }
}

browserLog();
browserProbe();
autoSetup().catch((error) => log(`auto-setup: crashed: ${error?.message ?? error}`));
