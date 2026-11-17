// Remote MCP server for vutoolkit in a container (Railway). Serves the generated MCP handler on
// $PORT with bearer-token auth, a /healthz route for the platform, and, when enabled, runs the
// one-time Vanderbilt setup by itself so no agent has to drive it. See README.md.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../", import.meta.url);
const { operations } = await import(new URL("dist/ops.js", root).href);
const { handler } = await import(new URL("dist/toolfactory/mcp.js", root).href);
const { context } = await import(new URL("dist/toolfactory/config.js", root).href);

const log = (message) => console.error(`[vutoolkit] ${message}`);
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
    const result = await op("setup.run").handler({ confirm: true, recovery: false, allowInteractiveVerification: true, timeoutSeconds: 300 }, ctx);
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
 * strings), and for OneVU pages the visible headings, controls and form error, emails redacted and
 * field values never read, so a changed sign-in flow can be diagnosed from the deploy logs.
 */
const ONEVU_PROBE = `(() => {
  const vis = e => !!(e && (e.offsetParent || e.getClientRects().length));
  const red = s => String(s || "").replace(/[^\\s@]+@[^\\s@]+/g, "<email>").replace(/\\s+/g, " ").trim();
  const pick = (sel, n) => [...document.querySelectorAll(sel)].filter(vis).map(e => red(e.innerText || e.value || e.getAttribute("aria-label")).slice(0, 50)).filter(Boolean).slice(0, n);
  return JSON.stringify({
    headings: pick("h1,h2,h3,legend", 4),
    inputs: [...document.querySelectorAll("input,select")].filter(vis).map(e => [e.type, e.name].join(":")).slice(0, 8),
    controls: pick("button,a.button,[data-se=button],input[type=submit]", 10),
    error: red(document.querySelector(".o-form-error-container")?.textContent).slice(0, 200)
  });
})()`;

function probe(wsUrl) {
  return new Promise((resolve) => {
    let ws;
    const done = (value) => { try { ws?.close(); } catch { /* closed */ } resolve(value); };
    try { ws = new WebSocket(wsUrl); } catch { return resolve(null); }
    const timer = setTimeout(() => done(null), 3000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: ONEVU_PROBE, returnByValue: true } }));
    ws.onmessage = (m) => { try { const r = JSON.parse(m.data); if (r.id === 1) { clearTimeout(timer); done(r.result?.result?.value ?? null); } } catch { /* ignore */ } };
    ws.onerror = () => { clearTimeout(timer); done(null); };
  });
}

function browserLog() {
  if (process.env.VUTOOLKIT_DEBUG_BROWSER !== "1" || !process.env.VUTOOLKIT_CDP_URL) return;
  let last = "";
  const seen = new Map();
  setInterval(async () => {
    try {
      const list = (await (await fetch(new URL("/json/list", process.env.VUTOOLKIT_CDP_URL))).json()).filter((t) => t.type === "page");
      const pages = list.map((t) => {
        let where = "";
        try { const u = new URL(t.url); where = u.origin === "null" ? u.href : u.origin + u.pathname; } catch { where = "?"; }
        return `${where} [${String(t.title ?? "").slice(0, 60)}]`;
      }).join(" | ");
      if (pages !== last) { last = pages; log(`browser: ${pages}`); }
      for (const t of list) {
        if (!String(t.url).startsWith("https://onevu.vanderbilt.edu/") || !t.webSocketDebuggerUrl) continue;
        const dom = await probe(t.webSocketDebuggerUrl);
        if (dom && seen.get(t.id) !== dom) { seen.set(t.id, dom); log(`onevu page: ${dom}`); }
      }
    } catch { /* browser restarting */ }
  }, 3000).unref();
}

browserLog();
// VUTOOLKIT_DEBUG_WEBAUTHN=1 runs a push-free browser check instead of setup (see webauthn-probe.mjs).
if (process.env.VUTOOLKIT_DEBUG_WEBAUTHN === "1") {
  log("auto-setup: skipped while VUTOOLKIT_DEBUG_WEBAUTHN=1.");
  (await import("./webauthn-probe.mjs")).webauthnProbe().catch((e) => log(`webauthn-probe crashed: ${e?.message ?? e}`));
} else autoSetup().catch((error) => log(`auto-setup: crashed: ${error?.message ?? error}`));
