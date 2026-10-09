/**
 * Session and passkey storage contracts. OpenClaw deployments configure native vault envelopes;
 * standalone deployments retain file storage. Values are never diagnostic output. The
 * authorized sessions.open operation intentionally returns an injection payload to its caller.
 */
import type { PasskeyMaterialV1 } from "../sso/material.js";

export type Idp = "vanderbilt" | "microsoft";

export interface SessionMeta {
  idp: Idp;
  acquiredAt: string;
  expiresAt?: string;
  healthy: boolean;
}

export interface StoredSession extends SessionMeta {
  /** Raw Cookie header for the idp's origin. Handled only by the store implementation. */
  cookieHeader: string;
}

export interface SessionStore {
  list(): Promise<SessionMeta[]>;
  get(idp: Idp): Promise<StoredSession | null>;
  put(session: StoredSession): Promise<void>;
  forget(idp: Idp): Promise<void>;
}

export interface SecretLoader {
  /** Resolve a SecretRef to passkey material; implementations never echo the value. */
  loadPasskey(secretRef: string): Promise<PasskeyMaterialV1>;
}

export class VaultNotWiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultNotWiredError";
  }
}

/** The typed "not yet" every gated operation raises until the OpenClaw-side wiring lands. */
export function vaultNotWired(what: string): never {
  throw new VaultNotWiredError(
    `${what}: SecretRef-backed wiring pending on the OpenClaw side (contract: src/vault/index.ts SessionStore / SecretLoader)`,
  );
}
