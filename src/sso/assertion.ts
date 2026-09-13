/**
 * Pure-Node WebAuthn assertion construction: the software-authenticator half of the ceremony.
 * Given vaulted passkey material, produces a spec-shaped assertion (authenticatorData ||
 * SHA-256(clientDataJSON), ES256 raw r||s) without a browser. This is the lightweight path;
 * the CDP virtual-authenticator ceremony in virtual-authenticator.ts is the high-fidelity one.
 */
import { createHash, createPrivateKey, sign as signDer, verify as verifyDer } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { MaterialError, publicKeyObject, type PasskeyMaterialV1 } from "./material.js";

export const b64url = (b: Buffer): string => b.toString("base64url");
export function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** UP (user present) | UV (user verified) — OneVU passkeys assert both. */
const UP_UV_FLAGS = 0x05;

export function buildClientDataJson(challengeB64url: string, origin: string): string {
  return JSON.stringify({ type: "webauthn.get", challenge: challengeB64url, origin, crossOrigin: false });
}

/** rpIdHash || flags || be32 signCount — the assertion's authenticatorData (37 bytes). */
export function buildAuthenticatorData(rpId: string, signCount: number): Buffer {
  const rpIdHash = createHash("sha256").update(rpId).digest();
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount >>> 0);
  return Buffer.concat([rpIdHash, Buffer.from([UP_UV_FLAGS]), count]);
}

function last32(b: Buffer): Buffer {
  return b.length > 32 ? b.subarray(b.length - 32) : b;
}
function pad32(b: Buffer): Buffer {
  return b.length < 32 ? Buffer.concat([Buffer.alloc(32 - b.length, 0), b]) : b;
}

/** ASN.1 DER ECDSA signature -> raw r||s (what WebAuthn transports carry). */
export function derToRaw(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new MaterialError("unexpected signature encoding (expected DER sequence)");
  let i = 2;
  const rLen = der[i + 1]!;
  const r = der.subarray(i + 2, i + 2 + rLen);
  i += 2 + rLen;
  const sLen = der[i + 1]!;
  const s = der.subarray(i + 2, i + 2 + sLen);
  return Buffer.concat([pad32(last32(r)), pad32(last32(s))]);
}

/** raw r||s -> DER (so node:crypto's verify can consume a transported WebAuthn signature). */
export function rawToDer(raw: Buffer): Buffer {
  const trim = (b: Buffer): Buffer => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i += 1;
    const v = b.subarray(i);
    return (v[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.alloc(1, 0), v]) : v;
  };
  const r = trim(raw.subarray(0, 32));
  const s = trim(raw.subarray(32));
  return Buffer.concat(
    [Buffer.from([0x30, r.length + s.length + 4, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s],
  );
}

export interface WebAuthnAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  /** Persist this back to the material after a successful ceremony. */
  nextSignCount: number;
}

export function buildAssertion(
  m: PasskeyMaterialV1,
  challengeB64url: string,
  origin: string,
): WebAuthnAssertion {
  const clientDataJSON = buildClientDataJson(challengeB64url, origin);
  const nextSignCount = (m.signCount + 1) >>> 0;
  const authData = buildAuthenticatorData(m.rpId, nextSignCount);
  const clientHash = createHash("sha256").update(clientDataJSON).digest();
  const der = signDer(
    "sha256",
    Buffer.concat([authData, clientHash]),
    createPrivateKey({ key: m.privateKeyJwk as JsonWebKey, format: "jwk" }),
  );
  return {
    credentialId: m.credentialId,
    authenticatorData: b64url(authData),
    clientDataJSON,
    signature: b64url(derToRaw(der)),
    nextSignCount,
  };
}

/** Offline self-check: recompute the signed message and verify against the public half. */
export function verifyAssertion(
  m: PasskeyMaterialV1,
  a: WebAuthnAssertion,
  expectedChallengeB64url: string,
  origin: string,
): boolean {
  const parsed = JSON.parse(a.clientDataJSON) as { type?: string; challenge?: string; origin?: string };
  if (parsed.type !== "webauthn.get" || parsed.challenge !== expectedChallengeB64url || parsed.origin !== origin)
    return false;
  const authData = fromB64url(a.authenticatorData);
  const clientHash = createHash("sha256").update(a.clientDataJSON).digest();
  return verifyDer(
    "sha256",
    Buffer.concat([authData, clientHash]),
    publicKeyObject(m),
    rawToDer(fromB64url(a.signature)),
  );
}
