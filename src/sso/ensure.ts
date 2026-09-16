/**
 * The zero-step auth loop from the design note: return the cached session if one is alive,
 * otherwise mint a new one from vault secrets via the OneVU (or Entra) ceremony and cache it.
 * The only decision an agent makes is calling sessions.ensure — never how auth happens, and
 * never whether the cached session actually still works.
 *
 * "Alive" is a real check, not cookie arithmetic: an Okta/Entra session idles out server-side
 * while its cookies keep a far-future expiry, so a fresh-looking row can be dead. ensureSession
 * probes the service and re-mints a dead-but-unexpired session, so a caller is never handed
 * cookies that fail on first use. Freshly minted or just-acquired sessions skip the probe.
 */
import { execFileSync } from "node:child_process";
import { harvestToStoredSession, type CookieRecord, type FileSessionStore } from "../vault/file-store.js";
import { VaultNotWiredError, type Idp, type SessionMeta, type StoredSession } from "../vault/index.js";
import { runSsoCeremony, type CeremonyOptions, type MintedSession, type VaultPasskey } from "./ceremony.js";
import { probeSession, type LivenessProbe } from "./liveness.js";
import { microsoftSessionFromSso, type MintedMicrosoftSession } from "./microsoft.js";

export type Ceremony = typeof runSsoCeremony;

/** A session minted this recently is trusted without a liveness round-trip. */
const PROBE_SKIP_MS = 120_000;
const DEFAULT_CDP_URL = "http://127.0.0.1:18800";

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

function defaultSecretsRead(name: string): string {
  return execFileSync("openclaw", ["secrets", "store", "get", name, "--plain"], {
    encoding: "utf8",
    timeout: 15000,
  }).trim();
}

/**
 * Make the managed browser reachable before a ceremony drives it. The ceremony needs the CDP
 * endpoint up; when it is down the mint fails with an opaque socket error, so bring the browser
 * up first (best-effort) and only then let the ceremony run — or fail with an actionable message.
 */
async function defaultEnsureBrowser(cdpUrl: string): Promise<void> {
  const versionUrl = new URL("/json/version", cdpUrl);
  const reachable = async (): Promise<boolean> => {
    try {
      const res = await fetch(versionUrl, { signal: AbortSignal.timeout(2500) });
      return res.ok;
    } catch {
      return false;
    }
  };
  if (await reachable()) return;
  try {
    execFileSync("openclaw", ["browser", "start"], { timeout: 30000, stdio: "ignore" });
  } catch {
    // Fall through to the reachability poll: the start command may fail while the browser is
    // in fact coming up, and the poll — not the command's exit code — is the real signal.
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await reachable()) return;
  }
  throw new Error(
    `managed browser is not reachable at ${cdpUrl} and could not be started; run \`openclaw browser start\` and retry`,
  );
}

async function mint(idp: Idp, store: FileSessionStore, deps: EnsureDeps): Promise<EnsureResult> {
  const env = deps.env ?? process.env;
  const secretsRead = deps.secretsRead ?? defaultSecretsRead;
  const email = env.VUTOOLKIT_VU_EMAIL || secretsRead("VANDERBILT_EMAIL");
  const cdpUrl = env.VUTOOLKIT_CDP_URL || DEFAULT_CDP_URL;
  await (deps.ensureBrowser ?? defaultEnsureBrowser)(cdpUrl);
  if (idp === "microsoft") {
    // The Entra session lives in the browser profile: the ceremony carries it directly when it
    // is alive, walks identifier-first + KMSI when it needs a nudge, and refuses loudly at any
    // password prompt — a credential decision is the design note's, never a guessed secret.
    const mintMicrosoft = deps.microsoftCeremony ?? microsoftSessionFromSso;
    const mintedMs: MintedMicrosoftSession = await mintMicrosoft({ cdpUrl, email });
    const storedMs = harvestToStoredSession(idp, mintedMs.cookies, mintedMs.acquiredAt);
    await store.put(storedMs);
    return { source: "minted", idp, acquiredAt: storedMs.acquiredAt, expiresAt: storedMs.expiresAt, healthy: true, finalUrl: mintedMs.finalUrl };
  }
  const passkey = parseVaultPasskey(env.VUTOOLKIT_PASSKEY_JSON || secretsRead("VANDERBILT_PASSKEY"));
  const ceremonyOptions: CeremonyOptions = { cdpUrl, email, passkey };
  const minted: MintedSession = await (deps.ceremony ?? runSsoCeremony)(ceremonyOptions);
  const stored = harvestToStoredSession(idp, minted.cookies, minted.acquiredAt);
  await store.put(stored);
  return { source: "minted", idp, acquiredAt: stored.acquiredAt, expiresAt: stored.expiresAt, healthy: true, finalUrl: minted.finalUrl };
}

export async function ensureSession(idp: Idp, store: FileSessionStore, deps: EnsureDeps = {}): Promise<EnsureResult> {
  const now = (deps.now ?? (() => new Date()))();
  const existing = await store.get(idp);
  if (existing && withinExpiry(existing, now)) {
    // Trust a just-minted session; otherwise confirm it still works before handing it back.
    if (justAcquired(existing, now)) {
      return { source: "cache", idp, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt, healthy: existing.healthy };
    }
    const cookies: CookieRecord[] = store.cookies(idp);
    const alive = await (deps.probe ?? probeSession)(idp, cookies);
    if (alive) {
      // Persist the confirmed-healthy verdict so sessions.list is honest too.
      if (!existing.healthy) await store.put({ ...existing, healthy: true });
      return { source: "cache", idp, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt, healthy: true };
    }
    // Fresh cookies, dead session: drop it and re-mint rather than hand back cookies that fail.
    await store.forget(idp);
  }
  return mint(idp, store, deps);
}
