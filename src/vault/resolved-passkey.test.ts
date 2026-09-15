import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import { installVirtualCredential } from "../sso/virtual-authenticator.js";
import { createResolvedPasskeyLoader, normalizeResolvedPasskey } from "./resolved-passkey.js";

function fixture() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    credentialId: Buffer.from([255, 254, 0]).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    rpId: "login.example.test", userHandle: "synthetic-user-☃", signCount: 42,
    isResidentCredential: false,
  };
}

it("wires a resolved legacy value through SecretLoader into CDP without changing key bytes or RP binding", async () => {
  const original = fixture();
  const loader = createResolvedPasskeyLoader({
    reference: "fixture-passkey", readResolvedValue: () => JSON.stringify(original),
    legacyHandleEncoding: "utf8",
  });
  const material = await loader.loadPasskey("fixture-passkey");
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({ authenticatorId: "offline" }));
  await installVirtualCredential({ send }, material);
  const credential = send.mock.calls[2]![1]!.credential as Record<string, unknown>;
  expect(credential).toMatchObject({
    rpId: original.rpId, credentialId: original.credentialId, privateKey: original.privateKey,
    userHandle: Buffer.from(original.userHandle).toString("base64"), signCount: 42,
  });
  expect(original.signCount).toBe(42);
});

it("supports explicit encoded legacy handles and versioned JWK material", () => {
  const raw = fixture();
  raw.userHandle = Buffer.from([255, 254, 0]).toString("base64");
  const material = normalizeResolvedPasskey(JSON.stringify(raw), "base64");
  expect(material.userHandle).toBe("__4A");
  const roundtrip = normalizeResolvedPasskey(JSON.stringify(material));
  expect(createPrivateKey({ key: { ...roundtrip.privateKeyJwk }, format: "jwk" })
    .export({ format: "der", type: "pkcs8" }).toString("base64")).toBe(raw.privateKey);
  expect(roundtrip).toEqual(material);
});

it("does not guess legacy handle encoding or silently downgrade a resident credential", () => {
  expect(() => normalizeResolvedPasskey(JSON.stringify(fixture()))).toThrow("format is unsupported");
  expect(() => normalizeResolvedPasskey(JSON.stringify({ ...fixture(), isResidentCredential: true }), "utf8"))
    .toThrow("format is unsupported");
});

it.each([-1, 1.5, 0x100000000])("rejects invalid counter %s without truncation", signCount => {
  expect(() => normalizeResolvedPasskey(JSON.stringify({ ...fixture(), signCount }), "utf8"))
    .toThrow("format is unsupported");
});

it("rejects an unbound ref before consulting the host and never falls back", async () => {
  const readResolvedValue = vi.fn();
  const loader = createResolvedPasskeyLoader({ reference: "fixture-passkey", readResolvedValue });
  await expect(loader.loadPasskey("other")).rejects.toThrow("reference is not bound");
  expect(readResolvedValue).not.toHaveBeenCalled();
});

it("fails closed for unresolved refs, sentinels, unavailable snapshots and unsafe error details", async () => {
  for (const value of [undefined, { source: "store", provider: "default", id: "fixture" },
    "oc-sent-v2.synthetic.end", '{"privateKey":"DO_NOT_ECHO"']) {
    const loader = createResolvedPasskeyLoader({ reference: "fixture", readResolvedValue: () => value });
    await expect(loader.loadPasskey("fixture")).rejects.toThrow("Protected passkey consumer is unavailable");
  }
  const loader = createResolvedPasskeyLoader({ reference: "fixture", readResolvedValue() {
    throw new Error("DO_NOT_ECHO");
  } });
  try { await loader.loadPasskey("fixture"); } catch (error) {
    expect(String(error)).not.toContain("DO_NOT_ECHO");
    expect((error as Error).cause).toBeUndefined();
  }
});

it("consults the current host snapshot on each load, including degradation after a successful load", async () => {
  let value: unknown = JSON.stringify(fixture());
  const loader = createResolvedPasskeyLoader({ reference: "fixture", readResolvedValue: () => value,
    legacyHandleEncoding: "utf8" });
  expect((await loader.loadPasskey("fixture")).signCount).toBe(42);
  value = undefined;
  await expect(loader.loadPasskey("fixture")).rejects.toThrow("consumer is unavailable");
});
