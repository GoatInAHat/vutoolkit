/**
 * The zero-step auth loop from the design note: return the cached session if one is fresh,
 * otherwise mint a new one from vault secrets via the OneVU ceremony and cache it. The only
 * decision an agent makes is calling sessions.ensure — never how auth happens.
 */
import { execFileSync } from "node:child_process";
import { harvestToStoredSession, type FileSessionStore } from "../vault/file-store.js";
import { VaultNotWiredError, type Idp, type SessionMeta, type StoredSession } from "../vault/index.js";
import { runSsoCeremony, type CeremonyOptions, type MintedSession, type VaultPasskey } from "./ceremony.js";

export type Ceremony = typeof runSsoCeremony;

export interface EnsureDeps {
  /** Override for tests; defaults to the real CDP ceremony. */
  ceremony?: Ceremony;
  /** Override for tests; defaults to the OpenClaw vault CLI. Never logs or echoes values. */
  secretsRead?: (name: string) => string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface EnsureResult extends SessionMeta {
  source: "cache" | "minted";
  finalUrl?: string;
}

function isFresh(session: StoredSession, now: Date): boolean {
  return !session.expiresAt || Date.parse(session.expiresAt) > now.getTime();
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

export async function ensureSession(idp: Idp, store: FileSessionStore, deps: EnsureDeps = {}): Promise<EnsureResult> {
  const now = (deps.now ?? (() => new Date()))();
  const existing = await store.get(idp);
  if (existing && isFresh(existing, now)) {
    return { source: "cache", idp, acquiredAt: existing.acquiredAt, expiresAt: existing.expiresAt, healthy: existing.healthy };
  }
  if (idp !== "vanderbilt") {
    throw new VaultNotWiredError(`sessions.ensure(${idp}): microsoft minting is build-order step 2 (SSO to graph) and is not implemented yet`);
  }
  const env = deps.env ?? process.env;
  const secretsRead = deps.secretsRead ?? defaultSecretsRead;
  const email = env.VUTOOLKIT_VU_EMAIL || secretsRead("VANDERBILT_EMAIL");
  const passkey = parseVaultPasskey(env.VUTOOLKIT_PASSKEY_JSON || secretsRead("VANDERBILT_PASSKEY"));
  const ceremonyOptions: CeremonyOptions = {
    cdpUrl: env.VUTOOLKIT_CDP_URL || "http://127.0.0.1:18800",
    email,
    passkey,
  };
  const minted: MintedSession = await (deps.ceremony ?? runSsoCeremony)(ceremonyOptions);
  const stored = harvestToStoredSession(idp, minted.cookies, minted.acquiredAt);
  await store.put(stored);
  return { source: "minted", idp, acquiredAt: stored.acquiredAt, expiresAt: stored.expiresAt, healthy: true, finalUrl: minted.finalUrl };
}
