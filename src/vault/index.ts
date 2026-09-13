/**
 * The vault contract: the ONLY boundary between vutoolkit core and the OpenClaw secret vault.
 * The OpenClaw side implements SessionStore and SecretLoader as SecretRef-backed wiring; core
 * code depends on these interfaces and nothing else. Session values and passkey material never
 * pass through any other module, never touch disk, logs, or tool output.
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
