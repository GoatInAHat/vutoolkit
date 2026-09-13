/**
 * Passkey material: the versioned, origin-agnostic contract for the tool's passkey. The same
 * shape serves a credential extracted from the old deployment or one born in a CDP virtual
 * authenticator — loaders and ceremonies branch on nothing but this envelope.
 *
 * The private key lives in the OpenClaw secret vault as a SecretRef; it must never be written
 * to disk, logs, or tool output by anything in this repo.
 */
import { createPublicKey } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";

export interface EcPrivateKeyJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
  /** PKCS-8-hidden by the vault; present only in memory after load. */
  d: string;
}

/** v1: a non-resident ES256 credential the tool can assert with. */
export interface PasskeyMaterialV1 {
  version: 1;
  /** base64url credential id as issued at registration. */
  credentialId: string;
  privateKeyJwk: EcPrivateKeyJwk;
  /** Relying party id the credential is bound to, e.g. "vanderbilt.edu". */
  rpId: string;
  /** base64url user handle from registration. */
  userHandle: string;
  /** Last signature counter value; ceremonies return the next value to persist. */
  signCount: number;
}

export class MaterialError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse and validate from either an object or a JSON string; reject anything unexpected. */
export function parsePasskeyMaterial(input: unknown): PasskeyMaterialV1 {
  const raw = typeof input === "string" ? (JSON.parse(input) as unknown) : input;
  if (!isRecord(raw)) throw new MaterialError("passkey material must be a JSON object");
  if (raw.version !== 1) throw new MaterialError(`unsupported material version ${String(raw.version)}`);
  const jwk = raw.privateKeyJwk;
  if (!isRecord(jwk) || jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || typeof jwk.d !== "string")
    throw new MaterialError("privateKeyJwk must be an EC P-256 JWK with private scalar d");
  if (typeof raw.credentialId !== "string" || raw.credentialId.length === 0)
    throw new MaterialError("credentialId (base64url) is required");
  if (typeof raw.rpId !== "string" || raw.rpId.length === 0) throw new MaterialError("rpId is required");
  if (typeof raw.userHandle !== "string") throw new MaterialError("userHandle (base64url) is required");
  if (typeof raw.signCount !== "number" || !Number.isInteger(raw.signCount) || raw.signCount < 0)
    throw new MaterialError("signCount must be a non-negative integer");
  return {
    version: 1,
    credentialId: raw.credentialId,
    privateKeyJwk: jwk as unknown as EcPrivateKeyJwk,
    rpId: raw.rpId,
    userHandle: raw.userHandle,
    signCount: raw.signCount,
  };
}

/** The public half (d stripped) — safe for logs, tests, and verification. */
export function publicKeyJwk(m: PasskeyMaterialV1): JsonWebKey {
  const { d: _d, ...pub } = m.privateKeyJwk;
  return pub as JsonWebKey;
}

/** Public key as a KeyObject for verification. */
export function publicKeyObject(m: PasskeyMaterialV1): KeyObject {
  return createPublicKey({ key: publicKeyJwk(m), format: "jwk" });
}
