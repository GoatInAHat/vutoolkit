/**
 * Live evidence harness for the ensure / session-cache / injection chain. Entry point:
 * `scripts/sso-ensure-live.mjs` (which re-execs this module under tsx). Proves, against the real
 * services and the account holder's own vault:
 *
 * 1. sessions.ensure(vanderbilt) returns a valid cached SSO session — the second call hits cache
 *    and the aai liveness probe confirms the cached session is alive (read-only GET).
 * 2. sessions.ensure(microsoft) returns a valid cached Microsoft session — the second call hits
 *    cache and probeMicrosoft's Graph GET /me answers 200.
 * 3. graph.call's injection chain (ensureSession -> store.cookies -> ensureGraphToken ->
 *    graphCall) serves a read-only GET /me?$select=id from the injected cached session.
 *
 * Uses a temporary VUTOOLKIT_DATA_DIR under the OS temp dir so nothing in the account holder's
 * real session vault is overwritten; VUTOOLKIT_CREDENTIAL_STORE=file keeps it a throwaway file.
 * Prints booleans, counts and final URLs only — never cookie or token values.
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

const log: Record<string, unknown> = {};
let ok = true;
const fail = (reason: string) => { ok = false; log.failure ??= reason; };

// The email is optional input here (the vaulted cookies carry identity); absence must not abort
// the run before the cache/injection evidence is collected.
let email: string | undefined;
try {
  email = env.VUTOOLKIT_VU_EMAIL || secret("VANDERBILT_EMAIL");
} catch {
  email = undefined;
  log.emailSource = "absent";
}

const dataDir = mkdtempSync(join(tmpdir(), "vutoolkit-ensure-live-"));
const store = sessionStore(dataDir, { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });

// Seed the throwaway vault from the account holder's own vaulted rows so the run proves the
// cache/injection chain against real sessions. Nothing is written back to the real vault.
const vaulted = sessionStore(env.VUTOOLKIT_DATA_DIR ?? join(homedir(), ".local", "share", "vutoolkit"),
  { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });
const seeded: string[] = [];
for (const idp of ["vanderbilt", "microsoft"] as const) {
  const row = await vaulted.get(idp);
  if (!row) continue;
  await store.put({ ...row, cookies: vaulted.cookies(idp) });
  seeded.push(idp);
}
log.seeded = seeded;
// A harness that quietly mints with no vaulted row would pass without proving anything about
// the cache path, so an empty seed list is a failure rather than a silent success.
if (seeded.length < 2) fail(`seeded ${seeded.length}/2 vaulted session rows`);

try {
  // 1 — Vanderbilt: ensure mints or serves cache, then a second call must be a cache hit whose
  // cached cookies pass the independent liveness probe (read-only aai GET).
  const vuDeps = email ? { env: { ...env, VUTOOLKIT_VU_EMAIL: email } } : {};
  const first = await ensureSession("vanderbilt", store, vuDeps);
  const second = await ensureSession("vanderbilt", store, vuDeps);
  const liveVu = await probeSession("vanderbilt", store.cookies("vanderbilt"));
  log.vanderbilt = {
    firstSource: first.source, secondSource: second.source, healthy: second.healthy,
    idp: second.idp, hasExpiry: Boolean(second.expiresAt), cookieCount: store.cookies("vanderbilt").length, liveProbeHealthy: liveVu,
  };
  if (second.source !== "cache") fail("vanderbilt second ensure did not serve cache");
  if (!second.healthy || !liveVu) fail("vanderbilt cached session failed the liveness probe");

  // 2 — Microsoft: same shape, proven by the Graph /me probe inside probeMicrosoft.
  const msFirst = await ensureSession("microsoft", store, vuDeps);
  const msSecond = await ensureSession("microsoft", store, vuDeps);
  const liveMs = await probeSession("microsoft", store.cookies("microsoft"));
  log.microsoft = {
    firstSource: msFirst.source, secondSource: msSecond.source, healthy: msSecond.healthy,
    idp: msSecond.idp, hasExpiry: Boolean(msSecond.expiresAt), cookieCount: store.cookies("microsoft").length, liveProbeHealthy: liveMs,
  };
  if (msSecond.source !== "cache") fail("microsoft second ensure did not serve cache");
  if (!msSecond.healthy || !liveMs) fail("microsoft cached session failed the liveness probe");

  // 3 — Injection chain exactly as graph.call builds it: ensure, then token from the injected
  // cookies, then a read-only GET. A non-200 means the injection did not carry.
  await ensureSession("microsoft", store, vuDeps);
  const cache = graphTokenCache(dataDir, { VUTOOLKIT_CREDENTIAL_STORE: "file" });
  const getToken = async (opts: { force?: boolean }) =>
    (await ensureGraphToken(store.cookies("microsoft"), cache, { ...opts, ...(email ? { loginHint: email } : {}) })).accessToken;
  const me = await graphCall("GET", "/me", { $select: "id" }, undefined, getToken);
  const injection = {
    status: me.status,
    hasId: Boolean(me.data && typeof me.data === "object" && typeof (me.data as { id?: unknown }).id === "string"),
    leaksToken: JSON.stringify(me).includes("eyJ"),
  };
  log.injection = injection;
  if (me.status !== 200) fail(`injected graph GET /me returned ${me.status}`);
  if (!injection.hasId) fail("graph /me response carried no id");
  if (injection.leaksToken) fail("graph response leaked bearer material");
} catch (error) {
  // Typed codes only: never message text, which could quote vault material.
  const e = error as { code?: string; name?: string };
  fail(String(e?.code ?? e?.name ?? "Error"));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok, ...log }));
process.exitCode = ok ? 0 : 1;
