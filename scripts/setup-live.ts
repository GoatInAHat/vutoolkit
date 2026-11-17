/**
 * Live evidence harness for the passkey setup flow. Entry point: `scripts/sso-setup-live.mjs`
 * (which re-execs this module under tsx). Proves, against the real OneVU and the account
 * holder's own vault, that the setup operations behave read-only on a host that already has a
 * valid toolkit passkey:
 *
 * 1. setup.status reports configured identity, structural passkey validity and browser
 *    availability without returning any credential material.
 * 2. setup.prepare opens the dedicated OneVU security tab, loads the configured key into a
 *    virtual authenticator, and reports whether the page is authenticated for the configured
 *    account — without issuing or writing a key.
 * 3. setup.run reuses the existing key (passkey="existing"), completes an isolated OneVU
 *    WebAuthn assertion and returns status ready/partial for the Vanderbilt + Microsoft chain.
 *
 * Enrollment (setup.enroll / first-time setup) is deliberately NOT performed here: creating an
 * account passkey is irreversible account mutation and is only valid when the account holder
 * explicitly directs it. This harness proves everything reachable without that authorization.
 *
 * Nothing is written back to the account holder's real session vault; a throwaway data dir is
 * used for the session rows setup.run seeds. Prints booleans, codes and counts only — never
 * cookie, token or passkey values.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSetup, setupStatus } from "../src/sso/setup.js";
import { runSetup } from "../src/sso/setup-run.js";
import { sessionStore } from "../src/vault/file-store.js";

const env: NodeJS.ProcessEnv = { ...process.env };
delete env.VITEST; // OpenClaw's CLI skips its entrypoint under VITEST; this is a real vault read.

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
// this harness resolved.
if (CLI !== "openclaw") {
  const cliDir = join(CLI, "..");
  if (!env.PATH!.split(":").includes(cliDir)) env.PATH = cliDir + ":" + env.PATH;
  process.env.PATH = env.PATH;
}

const log: Record<string, unknown> = {};
let ok = true;
const fail = (reason: string) => { ok = false; log.failure ??= reason; };

/**
 * Hard per-stage budget. Every live step here is bounded on its own (CDP HTTP timeouts,
 * resolveBrowser/ensureBrowser timeouts, setup.run's timeoutSeconds), but a wedged browser or
 * stalled IdP can still exceed the gate's wall clock and be killed with no evidence at all.
 *
 * 200s, not 90s: this host's managed CDP browser has been observed taking 55s just to hydrate
 * the OneVU security page during setup.prepare, and setup.run adds a real passkey assertion plus
 * a Microsoft liveness probe (20s on its own). A tighter budget fails healthy runs. The stages
 * plus process startup still finish far inside the gate's 420s verification timeout; this bound
 * exists to convert a wedge into a typed failure, not to police normal latency.
 */
const STAGE_TIMEOUT_MS = Number(process.env.VUTOOLKIT_SETUP_LIVE_STAGE_TIMEOUT_MS ?? 200_000);
class StageTimeout extends Error {
  readonly code = "STAGE_TIMEOUT";
}
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StageTimeout(`${name} exceeded ${STAGE_TIMEOUT_MS}ms`)), STAGE_TIMEOUT_MS);
  });
  try {
    const value = await Promise.race([run(), budget]);
    if (process.env.VUTOOLKIT_DEBUG) process.stderr.write(`setup-live: ${name} ok in ${Date.now() - startedAt}ms\n`);
    return value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "vutoolkit-setup-live-"));
// Seed the throwaway session vault from the account holder's own vaulted rows so setup.run can
// reuse a real session instead of minting one; nothing is written back.
const vaulted = sessionStore(env.VUTOOLKIT_DATA_DIR ?? join(homedir(), ".local", "share", "vutoolkit"),
  { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });
const store = sessionStore(dataDir, { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });
const seeded: string[] = [];
for (const idp of ["vanderbilt", "microsoft"] as const) {
  const row = await vaulted.get(idp);
  if (!row) continue;
  await store.put({ ...row, cookies: vaulted.cookies(idp) });
  seeded.push(idp);
}
log.seeded = seeded;

try {
  // 1 — status: metadata only, no credential material in the payload.
  const status = await stage("status", () => setupStatus({ env }));
  log.status = {
    identityConfigured: status.identityConfigured,
    emailConfigured: status.emailConfigured,
    passkeyConfigured: status.passkeyConfigured,
    passkeyValid: status.passkeyValid,
    browserAvailable: status.browserAvailable,
    readyForAuth: status.readyForAuth,
    leaksSecret: /privateKey|credentialId|signCount/.test(JSON.stringify(status)),
  };
  if (!status.passkeyValid) fail("setup.status did not report a structurally valid vaulted passkey");
  if (log.status.leaksSecret) fail("setup.status payload contained credential material");

  // 2 — prepare: opens the dedicated tab and loads the existing key, writes nothing. The
  // managed browser profile may legitimately be signed out of OneVU (setup.run mints through
  // the passkey ceremony instead), so both outcomes are valid; what must hold is that prepare
  // never issues or writes a key and never claims readiness it cannot prove.
  const prepared = await stage("prepare", () => prepareSetup({ keepTab: true }, { env }));
  log.prepare = {
    status: prepared.status,
    existingPasskeyPreserved: prepared.existingPasskeyPreserved,
    recoveryMode: prepared.recoveryMode,
    identityMatched: prepared.identityMatched,
    enrollmentAvailable: prepared.enrollmentAvailable,
    hasTab: Boolean(prepared.browserTabId),
    leaksSecret: /privateKey|credentialId|signCount/.test(JSON.stringify(prepared)),
  };
  if (!prepared.existingPasskeyPreserved) fail("setup.prepare did not preserve the existing key");
  if (log.prepare.leaksSecret) fail("setup.prepare payload contained credential material");
  // A "ready" verdict must be backed by both a matched identity and a visible enrollment
  // control; a "sign-in-required" verdict must carry the account-holder hand-off guidance.
  if (prepared.status === "ready" && !(prepared.identityMatched && prepared.enrollmentAvailable))
    fail("setup.prepare claimed ready without a matched identity and an enrollment control");
  if (prepared.status === "sign-in-required" && !/Control UI|sign in|identity/i.test(prepared.nextStep))
    fail("setup.prepare sign-in-required carried no actionable next step");

  // 3 — setup.run with the existing key: isolated assertion + Vanderbilt + Microsoft chain.
  const run = await stage("run", () => runSetup(dataDir, { confirm: true, recovery: false, allowInteractiveVerification: false, timeoutSeconds: 180 }, {
    env: { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" },
  }));
  log.run = {
    status: run.status,
    passkey: run.passkey,
    passkeyAssertion: run.passkeyAssertion,
    vanderbiltSession: run.vanderbiltSession,
    microsoftSession: run.microsoftSession,
    ...(run.microsoftError ? { microsoftError: run.microsoftError } : {}),
    verificationRequired: run.verificationRequired,
    leaksSecret: /privateKey|credentialId|signCount/.test(JSON.stringify(run)),
  };
  if (run.passkey !== "existing") fail(`setup.run rotated the key (passkey=${run.passkey})`);
  if (run.passkeyAssertion !== "verified") fail("setup.run did not verify the existing key with an isolated assertion");
  if (run.vanderbiltSession !== "ready") fail("setup.run did not reach a ready Vanderbilt session");
  if (log.run.leaksSecret) fail("setup.run payload contained credential material");
} catch (error) {
  // Typed codes only: never message text, which could quote vault material.
  const e = error as { code?: string; name?: string };
  const code = String(e?.code ?? e?.name ?? "Error");
  fail(code);
  if (error instanceof StageTimeout) {
    log.failureDetail = error.message;
    // A failed run still has to say what it proved: report the stages that already completed.
    log.stagesCompleted = Object.keys(log).filter((key) => ["status", "prepare", "run"].includes(key));
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok, ...log }));
process.exitCode = ok ? 0 : 1;
