import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { parsePasskeyMaterial } from "./material.js";
import { installVirtualCredential } from "./virtual-authenticator.js";

it("loads the original RP binding, key, handle and counter into CDP", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const id = Buffer.from([255, 254, 253, 0]);
  const handle = Buffer.from("synthetic-user");
  const material = parsePasskeyMaterial({
    version: 1,
    credentialId: id.toString("base64url"),
    privateKeyJwk: jwk,
    rpId: "login.example.test",
    userHandle: handle.toString("base64url"),
    signCount: 42,
  });
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const authenticatorId = await installVirtualCredential({
    async send(method, params) {
      calls.push({ method, params });
      return method === "WebAuthn.addVirtualAuthenticator"
        ? { authenticatorId: "test-authenticator" }
        : {};
    },
  }, material);

  expect(authenticatorId).toBe("test-authenticator");
  expect(calls.map(call => call.method)).toEqual([
    "WebAuthn.enable", "WebAuthn.addVirtualAuthenticator", "WebAuthn.addCredential",
  ]);
  const params = calls[2]!.params!;
  expect(params.authenticatorId).toBe(authenticatorId);
  const credential = params.credential as Record<string, unknown>;
  expect(credential).toMatchObject({
    credentialId: id.toString("base64"),
    rpId: material.rpId,
    userHandle: handle.toString("base64"),
    signCount: 42,
    isResidentCredential: false,
  });
  const restoredKey = createPrivateKey({
    key: Buffer.from(credential.privateKey as string, "base64"),
    format: "der",
    type: "pkcs8",
  });
  expect(restoredKey.export({ format: "jwk" })).toEqual(jwk);
  expect(material.signCount).toBe(42);
});
