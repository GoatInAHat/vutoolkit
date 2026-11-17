/**
 * Live evidence harness for the SSO -> Microsoft -> Graph session chain. Entry point:
 * `scripts/sso-graph-chain-live.mjs` (which re-execs this module under tsx). Proves, against the
 * real services and the account holder's own vault:
 *
 * 1. sessions.ensure(microsoft) serves the seeded cached session — the second call is a cache hit
 *    (no browser re-mint), and probeMicrosoft's read-only Graph GET /me confirms it is alive.
 * 2. graph.call's token provider — ensureGraphToken over the injected Entra cookies — silently
 *    mints a Graph token (no browser, no interaction).
 * 3. graphCall GET /me?$select=id,userPrincipalName,mail answers 200 with the configured
 *    Vanderbilt identity, and the returned body carries no bearer material.
 *
 * Read-only discipline: the only method used is GET; no Graph write verb is ever issued.
 *
 * Uses a temporary VUTOOLKIT_DATA_DIR under the OS temp dir so nothing in the account holder's
 * real session vault is overwritten; VUTOOLKIT_CREDENTIAL_STORE=file keeps it a throwaway file.
 * Prints booleans, counts and typed codes only — never cookie or token values, never message text.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../src/sso/ensure.js";
import { probeSession } from "../src/sso/liveness.js";
import { sessionStore } from "../src/vault/file-store.js";
import { graphCall } from "../src/graph/client.js";
import { ensureGraphToken, graphTokenCache } from "../src/graph/token.js";

const env: NodeJS.ProcessEnv = { ...process.env };
delete env.VITEST; // OpenClaw's CLI skips its entrypoint under VITEST; this is a real vault read.

/**
 * The CLI is on PATH for an interactive shell but not for every exec wrapper; fall back to the
 * conventional install location so the harness reports a vault failure, not a spawn ENOENT.
 */
function openclawBin(): string {
  for (const candidate of ["openclaw", join(homedir(), ".openclaw", "bin", "openclaw")]) {
    try {
      execFileSync(candidate, ["--version"], { env, stdio: "ignore", timeout: 20_000 });
      return candidate;
    } catch (error) {
      const e = error as { code?: string; status?: number | null };
      if (e?.code !== "ENOENT" && e?.status !== null && e?.status !== undefined) return candidate;
    }
  }
  return "openclaw";
}

const CLI = openclawBin();
// resolveBrowser and ensureBrowser shell out to the bare name on PATH, so export the location
// this harness resolved: without it, browser discovery fails before any evidence is collected.
if (CLI !== "openclaw") {
  const cliDir = join(CLI, "..");
  if (!env.PATH!.split(":").includes(cliDir)) env.PATH = cliDir + ":" + env.PATH;
  process.env.PATH = env.PATH;
}

const secret = (name: string): string =>
  execFileSync(CLI, ["secrets", "store", "get", name, "--plain"], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000,
  }).trim();

let failure: string | undefined;
const fail = (reason: string) => { failure ??= reason; };

// The email is the identity assertion's anchor; without it identityMatch cannot be evaluated,
// so an unreadable vault secret is a typed failure rather than a silent pass.
let email: string | undefined;
try {
  email = (env.VUTOOLKIT_VU_EMAIL || secret("VANDERBILT_EMAIL")).trim();
} catch (error) {
  email = undefined;
  fail("SECRET_VANDERBILT_EMAIL_UNAVAILABLE");
}

// Declared up front so a failure before a stage completes still prints that stage as absent.
let seeded: string[] = [];
let microsoft: Record<string, unknown> | undefined;
let token: { source: string } | undefined;
let graph: Record<string, unknown> | undefined;

const dataDir = mkdtempSync(join(tmpdir(), "vutoolkit-graph-chain-live-"));
const store = sessionStore(dataDir, { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });

try {
  // Seed the throwaway vault from the account holder's own vaulted rows so the run proves the
  // chain against real sessions. Nothing is written back to the real vault.
  const vaulted = sessionStore(
    env.VUTOOLKIT_DATA_DIR ?? join(homedir(), ".local", "share", "vutoolkit"),
    { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" },
  );
  for (const idp of ["vanderbilt", "microsoft"] as const) {
    const row = await vaulted.get(idp);
    if (!row) continue;
    await store.put({ ...row, cookies: vaulted.cookies(idp) });
    seeded.push(idp);
  }
  // The chain starts at a valid Vanderbilt SSO session and carries it into Microsoft, so both
  // rows are prerequisites; seeding fewer than 2 would prove the wrong thing.
  if (seeded.length < 2) fail("SEED_INCOMPLETE");

  // 1 — Microsoft session: first ensure serves the seeded cache, second must be a cache hit, and
  // the cached cookies pass probeMicrosoft's independent read-only Graph proof.
  const msFirst = await ensureSession("microsoft", store);
  const msSecond = await ensureSession("microsoft", store);
  const liveMs = await probeSession("microsoft", store.cookies("microsoft"));
  microsoft = {
    firstSource: msFirst.source,
    secondSource: msSecond.source,
    healthy: msSecond.healthy,
    cookieCount: store.cookies("microsoft").length,
    liveProbeHealthy: liveMs,
  };
  if (msSecond.source !== "cache") fail("MICROSOFT_NOT_CACHED_ON_SECOND_ENSURE");
  if (!msSecond.healthy || !liveMs) fail("MICROSOFT_LIVENESS_FAILED");

  // 2 + 3 — the rest of the chain exactly as src/ops.ts graph.call builds it: token from the
  // injected cookies (silent authorize over Entra cookies), then a read-only GET. The only
  // method issued anywhere in this harness is GET.
  const cache = graphTokenCache(dataDir, { VUTOOLKIT_CREDENTIAL_STORE: "file" });
  const getToken = async (opts: { force?: boolean }) =>
    (await ensureGraphToken(store.cookies("microsoft"), cache, { ...opts, ...(email ? { loginHint: email } : {}) })).accessToken;
  token = { source: cache.read() === null ? "minted" : "cache" };
  await getToken({});

  const me = await graphCall("GET", "/me", { $select: "id,userPrincipalName,mail" }, undefined, getToken);
  const data = (me.data ?? {}) as { id?: unknown; userPrincipalName?: unknown; mail?: unknown };
  const wanted = String(email ?? "").toLowerCase();
  const identity = [data.userPrincipalName, data.mail]
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
  graph = {
    status: me.status,
    hasId: typeof data.id === "string" && data.id !== "",
    identityMatch: Boolean(wanted) && identity.some((v) => v.includes(wanted)),
    leaksToken: JSON.stringify(me).includes("eyJ"),
  };
  if (me.status !== 200) fail(`GRAPH_ME_STATUS_${me.status}`);
  if (!graph.hasId) fail("GRAPH_ME_NO_ID");
  if (!graph.identityMatch) fail("IDENTITY_MISMATCH");
  if (graph.leaksToken) fail("GRAPH_RESPONSE_LEAKED_BEARER");
} catch (error) {
  // Typed codes only: never message text, which could quote vault material.
  const e = error as { code?: string; name?: string };
  fail(String(e?.code ?? e?.name ?? "Error"));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

// One JSON line, keys in the plan's order, `failure` only when set: a single parseable object
// the slice closeout can cite verbatim.
const result = {
  ok: failure === undefined,
  seeded,
  microsoft,
  token,
  graph,
  ...(failure === undefined ? {} : { failure }),
};
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
