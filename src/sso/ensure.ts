/**
 * The zero-step auth loop from the design note: return the cached session if it is alive,
 * otherwise mint a new one from vault secrets and cache it. The only decision an agent makes is
 * calling sessions.ensure — never how auth happens, whether the cached session still works,
 * whether the browser is running, or whether another call is already minting.
 *
 * Guarantees, in order of the failures they remove:
 * - Liveness, not cookie arithmetic: a cached session is probed against the real service and a
 *   dead-but-unexpired one is re-minted (Okta and Entra idle out server-side while cookies keep
 *   a far-future expiry). Sessions acquired in the last two minutes skip the probe.
 * - The managed browser is started when its CDP endpoint is down (a Gateway restart kills it).
 * - Microsoft rides OneVU federation: when the Outlook carry lands on OneVU sign-in, the passkey
 *   ceremony signs the browser in and the carry runs again.
 * - Concurrent ensure calls for one vault and IdP share a single attempt, and browser ceremonies
 *   run one at a time, so parallel agents never race two sign-ins in one browser profile.
 * - A transient failure is retried once; a permanent one (missing vault secret, harvest without
 *   IdP cookies, a Microsoft password prompt) fails immediately with a typed, actionable message.
 * - The whole call is bounded, so a caller is never left waiting on a hung browser.
 */
import { execFileSync } from "node:child_process";
import { harvestToStoredSession, type CookieRecord, type FileSessionStore } from "../vault/file-store.js";
import { VaultNotWiredError, type Idp, type SessionMeta, type StoredSession } from "../vault/index.js";
import { cdpReachable } from "./cdp-driver.js";
import { runSsoCeremony, type MintedSession, type VaultPasskey } from "./ceremony.js";
import { AuthError, withDeadline } from "./errors.js";
import { probeSession, type LivenessProbe } from "./liveness.js";
import { MicrosoftNotConfiguredError, microsoftSessionFromSso, type MintedMicrosoftSession } from "./microsoft.js";

export type Ceremony = typeof runSsoCeremony;

/** A session minted this recently is trusted without a liveness round-trip. */
const PROBE_SKIP_MS = 120_000;
const DEFAULT_CDP_URL = "http://127.0.0.1:18800";
/** One ensure call, including a browser start, the federation hop, and one retry. */
const ENSURE_DEADLINE_MS = 6 * 60_000;
const RETRY_DELAY_MS = 3_000;

export interface EnsureDeps {
  /** Override for tests; defaults to the real CDP ceremony. */
  ceremony?: Ceremony;
  /** Override for tests; defaults to the real Microsoft Entra-carry ceremony. */
  microsoftCeremony?: typeof microsoftSessionFromSso;
  /** Override for tests; defaults to the real service liveness probe. */
  probe?: LivenessProbe;
  /** Override for tests; defaults to launching the managed browser when its CDP endpoint is down. */
  ensureBrowser?: (cdpUrl: string) => Promise<void>;
  /** Override for tests; defaults to the OpenClaw vault CLI. Never logs or echoes values. */
  secretsRead?: (name: string) => string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Override for tests; delay before the single retry of a transient failure. */
  retryDelayMs?: number;
  /** Override for tests; bound on the whole ensure call. */
  deadlineMs?: number;
}

export interface EnsureResult extends SessionMeta {
  source: "cache" | "minted";
  finalUrl?: string;
}

function withinExpiry(session: StoredSession, now: Date): boolean {
  return !session.expiresAt || Date.parse(session.expiresAt) > now.getTime();
}

function justAcquired(session: StoredSession, now: Date): boolean {
  const acquired = Date.parse(session.acquiredAt);
  return Number.isFinite(acquired) && now.getTime() - acquired < PROBE_SKIP_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opt-in stage timing on stderr (VUTOOLKIT_DEBUG=1); lines carry stage names and durations only, never values. */
function tracer(env: NodeJS.ProcessEnv, idp: Idp): (stage: string, startedAt: number) => void {
  if (!env.VUTOOLKIT_DEBUG) return () => {};
  return (stage, startedAt) => process.stderr.write(`vutoolkit ensure ${idp}: ${stage} ${Date.now() - startedAt}ms\n`);
}

/** Parse the vault's raw passkey shape; error messages never quote material. */
export function parseVaultPasskey(raw: string): VaultPasskey {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new VaultNotWiredError("vault passkey entry is not valid JSON");
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.credentialId !== "string" || typeof v.privateKey !== "string" ||
    typeof v.userHandle !== "string" || typeof v.rpId !== "string" ||
    typeof v.signCount !== "number" || !Number.isFinite(v.signCount)
  ) {
    throw new VaultNotWiredError("vault passkey entry is missing required fields");
  }
  return { credentialId: v.credentialId, privateKey: v.privateKey, userHandle: v.userHandle, rpId: v.rpId, signCount: v.signCount };
}

export function defaultSecretsRead(name: string): string {
  let value = "";
  try {
    value = execFileSync("openclaw", ["secrets", "store", "get", name, "--plain"], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (cause) {
    throw new AuthError("VAULT_SECRET_UNAVAILABLE", `could not read ${name} from the OpenClaw vault; it must exist as an env-kind entry (openclaw secrets store list)`, { retryable: false, cause });
  }
  if (!value) {
    throw new AuthError("VAULT_SECRET_UNAVAILABLE", `the OpenClaw vault entry ${name} is empty`, { retryable: false });
  }
  return value;
}

/**
 * Make the managed browser reachable before a ceremony drives it: a Gateway restart kills it, and
 * a ceremony against a closed CDP port would otherwise fail with a bare socket error. The start
 * command pins the "openclaw" profile and headless mode rather than inheriting config defaults:
 * the default profile can be node-auto-routed (a zero-config browser proxy once aimed it at a
 * Mac, launching Chrome there while this code polls local CDP). The cdpReachable poll, not the
 * command's exit code, stays the source of truth for readiness.
 */
export async function defaultEnsureBrowser(cdpUrl: string): Promise<void> {
  if (await cdpReachable(cdpUrl)) return;
  try {
    execFileSync("openclaw", ["browser", "--browser-profile", "openclaw", "start", "--headless"], { timeout: 45_000, stdio: "ignore" });
  } catch {
    // The poll below, not the command's exit code, is the real signal: the browser can come up
    // while the command reports a failure.
  }
  for (let i = 0; i < 20; i++) {
    if (await cdpReachable(cdpUrl)) return;
    await sleep(1500);
  }
  throw new AuthError(
    "BROWSER_UNAVAILABLE",
    `the managed browser is not reachable at ${cdpUrl} and did not start; check \`openclaw browser status\``,
    { retryable: true },
  );
}

/**
 * Browser ceremonies run one at a time: two tabs signing in at once can leave both
 * half-authenticated. A predecessor is waited on for at most CEREMONY_LOCK_MAX_WAIT_MS (longer
 * than any ceremony's own deadline), so one stuck ceremony can never block later sign-ins.
 */
const CEREMONY_LOCK_MAX_WAIT_MS = 150_000;
let ceremonyQueue: Promise<unknown> = Promise.resolve();
function oneCeremonyAtATime<T>(work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const maxWait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CEREMONY_LOCK_MAX_WAIT_MS);
    timer.unref(); // never keep a CLI process alive just to wait out the cap
  });
  const gate = Promise.race([ceremonyQueue.catch(() => undefined), maxWait]).finally(() => clearTimeout(timer));
  const run = gate.then(work);
  ceremonyQueue = run.catch(() => undefined);
  return run;
}

interface MintContext {
  store: FileSessionStore;
  deps: EnsureDeps;
  cdpUrl: string;
  email: () => string;
  passkey: () => VaultPasskey;
}

function resultFrom(idp: Idp, stored: StoredSession, finalUrl: string): EnsureResult {
  return { source: "minted", idp, acquiredAt: stored.acquiredAt, expiresAt: stored.expiresAt, healthy: true, finalUrl };
}

async function mintVanderbilt(ctx: MintContext): Promise<EnsureResult> {
  const passkey = ctx.passkey();
  const minted: MintedSession = await oneCeremonyAtATime(() =>
    (ctx.deps.ceremony ?? runSsoCeremony)({ cdpUrl: ctx.cdpUrl, email: ctx.email(), passkey }),
  );
  const stored = harvestToStoredSession("vanderbilt", minted.cookies, minted.acquiredAt);
  await ctx.store.put(stored);
  return resultFrom("vanderbilt", stored, minted.finalUrl);
}

async function mintMicrosoft(ctx: MintContext): Promise<EnsureResult> {
  const carry = () =>
    oneCeremonyAtATime(() => (ctx.deps.microsoftCeremony ?? microsoftSessionFromSso)({ cdpUrl: ctx.cdpUrl, email: ctx.email() }));
  let minted: MintedMicrosoftSession;
  try {
    minted = await carry();
  } catch (error) {
    if (!(error instanceof AuthError && error.code === "OKTA_SESSION_REQUIRED")) throw error;
    // Federation hop with no Okta session in the browser: sign in with the passkey, carry again.
    await mintVanderbilt(ctx);
    minted = await carry();
  }
  const stored = harvestToStoredSession("microsoft", minted.cookies, minted.acquiredAt);
  await ctx.store.put(stored);
  return resultFrom("microsoft", stored, minted.finalUrl);
}

/** Failures a second attempt cannot fix. */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof VaultNotWiredError ||
    error instanceof MicrosoftNotConfiguredError ||
    (error instanceof AuthError && !error.retryable)
  );
}

async function mint(idp: Idp, store: FileSessionStore, deps: EnsureDeps): Promise<EnsureResult> {
  const env = deps.env ?? process.env;
  const secretsRead = deps.secretsRead ?? defaultSecretsRead;
  const cdpUrl = env.VUTOOLKIT_CDP_URL || DEFAULT_CDP_URL;
  // Secrets are read lazily and at most once: the Microsoft carry needs the passkey only when
  // federation sends it through OneVU sign-in.
  let email: string | undefined;
  let passkey: VaultPasskey | undefined;
  const ctx: MintContext = {
    store,
    deps,
    cdpUrl,
    email: () => (email ??= env.VUTOOLKIT_VU_EMAIL || secretsRead("VANDERBILT_EMAIL")),
    passkey: () => (passkey ??= parseVaultPasskey(env.VUTOOLKIT_PASSKEY_JSON || secretsRead("VANDERBILT_PASSKEY"))),
  };
  const trace = tracer(env, idp);
  const attempt = async (n: number): Promise<EnsureResult> => {
    const started = Date.now();
    try {
      await (deps.ensureBrowser ?? defaultEnsureBrowser)(cdpUrl);
      trace(`attempt ${n} browser ready`, started);
      const result = await (idp === "microsoft" ? mintMicrosoft(ctx) : mintVanderbilt(ctx));
      trace(`attempt ${n} minted`, started);
      return result;
    } catch (error) {
      trace(`attempt ${n} failed (${error instanceof AuthError ? error.code : error instanceof Error ? error.name : "error"})`, started);
      throw error;
    }
  };
  try {
    return await attempt(1);
  } catch (error) {
    if (isPermanent(error)) throw error;
    await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
    return attempt(2);
  }
}

async function ensureOnce(idp: Idp, store: FileSessionStore, deps: EnsureDeps): Promise<EnsureResult> {
  const now = (deps.now ?? (() => new Date()))();
  const existing = await store.get(idp);
  if (existing && withinExpiry(existing, now)) {
    if (justAcquired(existing, now)) {
      return { source: "cache", idp, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt, healthy: existing.healthy };
    }
    const cookies: CookieRecord[] = store.cookies(idp);
    const probeStarted = Date.now();
    const alive = await (deps.probe ?? probeSession)(idp, cookies);
    tracer(deps.env ?? process.env, idp)(`probe ${alive ? "alive" : "dead"}`, probeStarted);
    if (alive) {
      if (!existing.healthy) await store.put({ ...existing, cookies, healthy: true });
      return { source: "cache", idp, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt, healthy: true };
    }
    // Unexpired cookies, dead session: drop it and re-mint rather than hand back cookies that fail.
    await store.forget(idp);
  }
  return mint(idp, store, deps);
}

/** Concurrent ensure calls for one vault file and IdP share a single attempt. */
const inflight = new Map<string, Promise<EnsureResult>>();

export function ensureSession(idp: Idp, store: FileSessionStore, deps: EnsureDeps = {}): Promise<EnsureResult> {
  const key = `${store.location}::${idp}`;
  const running = inflight.get(key);
  if (running) return running;
  const work = withDeadline(ensureOnce(idp, store, deps), deps.deadlineMs ?? ENSURE_DEADLINE_MS, `sessions.ensure(${idp})`)
    .finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}
