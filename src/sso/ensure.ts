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
 * - Concurrent refresh and ensure calls for one vault and IdP share one attempt through
 *   counter persistence. Different IdPs stay independent; federation shares the OneVU mint.
 * - A transient failure is retried once; a permanent one (missing vault secret, harvest without
 *   IdP cookies, a Microsoft password prompt) fails immediately with a typed, actionable message.
 * - The whole call is bounded, so a caller is never left waiting on a hung browser.
 */
import { authSignal } from "./budget.js";
import { execFileSync } from "node:child_process";
import { harvestToStoredSession, type CookieRecord, type FileSessionStore } from "../vault/file-store.js";
import { VaultNotWiredError, type Idp, type SessionMeta, type StoredSession } from "../vault/index.js";
import { nativeSecrets } from "../vault/credential-store.js";
import { ensureBrowser, resolveBrowser } from "./browser-config.js";
import { CounterAccountingError, runSsoCeremony, type MintedSession, type VaultPasskey } from "./ceremony.js";
import { AuthError, withDeadline } from "./errors.js";
import { probeSession, type LivenessProbe } from "./liveness.js";
import { MicrosoftNotConfiguredError, microsoftSessionFromSso, type MintedMicrosoftSession } from "./microsoft.js";

export type Ceremony = typeof runSsoCeremony;

/** A session minted this recently is trusted without a liveness round-trip. */
const PROBE_SKIP_MS = 120_000;
/** One ensure call, including a browser start, the federation hop, and one retry. */
const ENSURE_DEADLINE_MS = 6 * 60_000;
const RETRY_DELAY_MS = 3_000;

export interface EnsureDeps {
  /** Force a replacement without deleting the current session before success. */
  forceRefresh?: boolean;
  /** Cancellation is checked before assertions and after durable counter readback. */
  signal?: AbortSignal;
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
  secretsWrite?: (name: string, value: string) => void | Promise<void>;
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
  passkeyVerified?: boolean;
  assertedSignCount?: number;
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
  return { credentialId: v.credentialId, privateKey: v.privateKey, userHandle: v.userHandle, rpId: v.rpId, signCount: v.signCount,
    ...(typeof v.isResidentCredential === "boolean" ? { isResidentCredential: v.isResidentCredential } : {}) };
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
    throw new AuthError("VAULT_SECRET_UNAVAILABLE", `could not read ${name} from the OpenClaw vault; configure this named entry through the host's credential setup`, { retryable: false, cause });
  }
  if (!value) {
    throw new AuthError("VAULT_SECRET_UNAVAILABLE", `the OpenClaw vault entry ${name} is empty`, { retryable: false });
  }
  return value;
}

/** Compatibility wrapper for callers with an already-selected endpoint. */
export async function defaultEnsureBrowser(cdpUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const selected = await resolveBrowser(env);
  // A caller-provided endpoint is authoritative even when host defaults have changed.
  const sameEndpoint = new URL(selected.cdpUrl).href === new URL(cdpUrl).href;
  await ensureBrowser(sameEndpoint ? selected : { cdpUrl, source: "endpoint", canStart: false });
}

/** No timeout releases ownership of an assertion or its durable counter write. */
function checkAbort(deps: EnsureDeps): void { deps.signal?.throwIfAborted(); }

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
  checkAbort(ctx.deps);
  const passkey = ctx.passkey();
  const accountCounter = async (count: number) => {
    if ((ctx.deps.env ?? process.env).VUTOOLKIT_PASSKEY_JSON) return;
    const read = ctx.deps.secretsRead ?? defaultSecretsRead;
    const currentRaw = read("VANDERBILT_PASSKEY");
    const current = parseVaultPasskey(currentRaw);
    if (["credentialId", "privateKey", "userHandle", "rpId"].some(field => current[field as keyof VaultPasskey] !== passkey[field as keyof VaultPasskey]))
      throw new AuthError("VAULT_SECRET_UNAVAILABLE", "The active passkey changed during sign-in; no credential was overwritten.", { retryable: false });
    if (count > current.signCount) {
      const updated = JSON.stringify({ ...JSON.parse(currentRaw), signCount: count });
      if (read("VANDERBILT_PASSKEY") !== currentRaw)
        throw new AuthError("VAULT_SECRET_UNAVAILABLE", "The passkey changed before its counter update; no credential was overwritten.", { retryable: false });
      await (ctx.deps.secretsWrite ?? nativeSecrets.write)("VANDERBILT_PASSKEY", updated);
      if (read("VANDERBILT_PASSKEY") !== updated)
        throw new AuthError("VAULT_SECRET_UNAVAILABLE", "The passkey counter write could not be verified; no session replacement was published.", { retryable: false });
    }
    // Refresh the in-memory material too, so any outer retry starts above durable state.
    passkey.signCount = Math.max(passkey.signCount, count, current.signCount);
  };
  const minted: MintedSession = await (ctx.deps.ceremony ?? runSsoCeremony)({ cdpUrl: ctx.cdpUrl, email: ctx.email(), passkey,
    requireAssertion: true, signal: ctx.deps.signal, accountCounter });
  // Compatibility with injected ceremonies; the real ceremony accounts on every exit.
  if (minted.assertedSignCount !== undefined) {
    try { await accountCounter(minted.assertedSignCount); }
    catch (cause) { throw new CounterAccountingError(cause); }
  }
  checkAbort(ctx.deps);
  const stored = harvestToStoredSession("vanderbilt", minted.cookies, minted.acquiredAt);
  await ctx.store.put(stored);
  return { ...resultFrom("vanderbilt", stored, minted.finalUrl),
    ...(minted.passkeyVerified ? { passkeyVerified: true, assertedSignCount: minted.assertedSignCount } : {}) };
}

async function mintMicrosoft(ctx: MintContext): Promise<EnsureResult> {
  const carry = () => {
    checkAbort(ctx.deps);
    return (ctx.deps.microsoftCeremony ?? microsoftSessionFromSso)({ cdpUrl: ctx.cdpUrl, email: ctx.email() });
  };
  let minted: MintedMicrosoftSession;
  try {
    minted = await carry();
  } catch (error) {
    if (!(error instanceof AuthError && error.code === "OKTA_SESSION_REQUIRED")) throw error;
    // Federation hop with no Okta session in the browser: sign in with the passkey, carry again.
    await ensureSession("vanderbilt", ctx.store, { ...ctx.deps, forceRefresh: true }); // The carry needs the shared browser's OneVU session.
    minted = await carry();
  }
  const stored = harvestToStoredSession("microsoft", minted.cookies, minted.acquiredAt);
  checkAbort(ctx.deps);
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
  checkAbort(deps);
  const env = deps.env ?? process.env;
  const secretsRead = deps.secretsRead ?? defaultSecretsRead;
  const browser = await resolveBrowser(env);
  const cdpUrl = browser.cdpUrl;
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
    checkAbort(deps);
    const started = Date.now();
    try {
      if (deps.ensureBrowser) await deps.ensureBrowser(cdpUrl);
      else await ensureBrowser(browser);
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
    // Never replace accounting uncertainty with an abort reason and release its flight.
    if (error instanceof CounterAccountingError) throw error;
    checkAbort(deps);
    if (isPermanent(error)) throw error;
    await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
    return attempt(2);
  }
}

async function ensureOnce(idp: Idp, store: FileSessionStore, deps: EnsureDeps): Promise<EnsureResult> {
  const now = (deps.now ?? (() => new Date()))();
  const existing = await store.get(idp);
  if (!deps.forceRefresh && existing && withinExpiry(existing, now)) {
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
    // Replace only after a successful mint. An auth failure must not erase the preserved row.
  }
  return mint(idp, store, deps);
}

/** Ownership lasts until the actual work settles, not until a caller times out. */
const inflight = new Map<string, { work: Promise<EnsureResult>; controller: AbortController; waiters: number }>();

export function ensureSession(idp: Idp, store: FileSessionStore, deps: EnsureDeps = {}): Promise<EnsureResult> {
  deps = { ...deps, signal: deps.signal ?? authSignal() };
  try { checkAbort(deps); } catch (error) { return Promise.reject(error); }
  const key = `${store.location}::${idp}`;
  let flight = inflight.get(key);
  if (!flight) {
    const controller = new AbortController();
    const work = Promise.resolve().then(() => ensureOnce(idp, store, { ...deps, signal: controller.signal }))
      .then(result => { inflight.delete(key); return result; }, error => {
        // A failed readback must not release ownership for a second assertion with stale
        // material. Retain this rejected flight until operator reconciliation/restart.
        if (!(error instanceof CounterAccountingError)) inflight.delete(key);
        throw error;
      });
    flight = { work, controller, waiters: 0 };
    inflight.set(key, flight);
  }
  const owned = flight;
  owned.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--owned.waiters === 0) owned.controller.abort();
  };
  deps.signal?.addEventListener("abort", release, { once: true });
  const started = Date.now();
  return withDeadline(owned.work, deps.deadlineMs ?? ENSURE_DEADLINE_MS, `sessions.ensure(${idp})`)
    .then(result => {
      checkAbort(deps);
      // Joining a healthy-cache ensure must not turn a forced refresh into a fake mint.
      if (deps.forceRefresh && result.source === "cache") {
        const remaining = (deps.deadlineMs ?? ENSURE_DEADLINE_MS) - (Date.now() - started);
        if (remaining <= 0) throw new AuthError("TIMEOUT", "sessions.refresh exhausted its caller budget", { retryable: true });
        return ensureSession(idp, store, { ...deps, deadlineMs: remaining });
      }
      return result;
    })
    .finally(() => { deps.signal?.removeEventListener("abort", release); release(); });
}
