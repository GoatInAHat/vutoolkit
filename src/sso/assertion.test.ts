import { generateKeyPairSync } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { b64url, buildAssertion, buildAuthenticatorData, verifyAssertion } from "./assertion.js";
import { parsePasskeyMaterial } from "./material.js";

const ORIGIN = "https://onevu.vanderbilt.edu";
const CHALLENGE = b64url(Buffer.from("challenge-bytes-0123456789abcdef"));

function fixtureMaterial() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as JsonWebKey;
  return parsePasskeyMaterial({
    version: 1,
    credentialId: b64url(Buffer.from("credential-1")),
    privateKeyJwk: jwk,
    rpId: "vanderbilt.edu",
    userHandle: b64url(Buffer.from("user-1")),
    signCount: 0,
  });
}

describe("webauthn assertion (software authenticator)", () => {
  it("produces a signature that verifies against the credential's public half", () => {
    const m = fixtureMaterial();
    const a = buildAssertion(m, CHALLENGE, ORIGIN);
    expect(a.nextSignCount).toBe(1);
    expect(verifyAssertion(m, a, CHALLENGE, ORIGIN)).toBe(true);
  });

  it("rejects tampered signatures and mismatched challenges", () => {
    const m = fixtureMaterial();
    const a = buildAssertion(m, CHALLENGE, ORIGIN);
    const tampered = { ...a, signature: a.signature.slice(0, -4) + "AAAA" };
    expect(verifyAssertion(m, tampered, CHALLENGE, ORIGIN)).toBe(false);
    expect(verifyAssertion(m, a, b64url(Buffer.from("other-challenge")), ORIGIN)).toBe(false);
    expect(verifyAssertion(m, a, CHALLENGE, "https://evil.example")).toBe(false);
  });

  it("shapes authenticatorData per spec: 37 bytes, rpIdHash, UP|UV flags, big-endian count", () => {
    const ad = buildAuthenticatorData("vanderbilt.edu", 42);
    expect(ad.length).toBe(37);
    expect(ad.subarray(0, 32).equals(createHash("sha256").update("vanderbilt.edu").digest())).toBe(true);
    expect(ad[32]).toBe(0x05);
    expect(ad.readUInt32BE(33)).toBe(42);
  });

  it("advances the sign counter monotonically across assertions", () => {
    const m = fixtureMaterial();
    const a1 = buildAssertion(m, CHALLENGE, ORIGIN);
    const m2 = parsePasskeyMaterial({ ...m, signCount: a1.nextSignCount });
    const a2 = buildAssertion(m2, CHALLENGE, ORIGIN);
    expect(a2.nextSignCount).toBe(2);
  });
});
