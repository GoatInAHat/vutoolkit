import { createPrivateKey } from "node:crypto";
import { parsePasskeyMaterial, type PasskeyMaterialV1 } from "../sso/material.js";
import { VaultNotWiredError, type SecretLoader } from "./index.js";

export type LegacyHandleEncoding = "utf8" | "base64";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binary(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) throw new Error();
  const unpadded = value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const bytes = Buffer.from(unpadded, "base64url");
  if (bytes.toString("base64url") !== unpadded) throw new Error();
  return bytes.toString("base64url");
}

/** In-memory normalization only. Legacy user handles require an explicit encoding contract. */
export function normalizeResolvedPasskey(
  value: unknown,
  legacyHandleEncoding?: LegacyHandleEncoding,
): PasskeyMaterialV1 {
  try {
    if (typeof value !== "string" || value.startsWith("oc-sent-")) throw new Error();
    const raw: unknown = JSON.parse(value);
    if (!record(raw)) throw new Error();
    let material: PasskeyMaterialV1;
    if (raw.version === 1) {
      material = parsePasskeyMaterial(raw);
    } else {
      // v1 only supports non-resident credentials. Do not silently change residency.
      if (raw.version !== undefined || raw.isResidentCredential !== false ||
          typeof raw.userHandle !== "string" || !legacyHandleEncoding) throw new Error();
      const key = createPrivateKey({
        key: Buffer.from(binary(raw.privateKey), "base64url"), format: "der", type: "pkcs8",
      });
      material = parsePasskeyMaterial({
        version: 1, credentialId: binary(raw.credentialId), rpId: raw.rpId,
        privateKeyJwk: key.export({ format: "jwk" }), signCount: raw.signCount,
        userHandle: legacyHandleEncoding === "utf8"
          ? Buffer.from(raw.userHandle, "utf8").toString("base64url") : binary(raw.userHandle),
      });
    }
    if (material.signCount > 0xffffffff) throw new Error();
    // Import validates the key before handing it to a ceremony; never return untrusted extras.
    const key = createPrivateKey({ key: { ...material.privateKeyJwk }, format: "jwk" });
    const jwk = key.export({ format: "jwk" });
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error();
    return {
      ...material, credentialId: binary(material.credentialId), userHandle: binary(material.userHandle),
      privateKeyJwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d! },
    };
  } catch {
    // JSON/crypto errors may quote source material. Do not forward their message or cause.
    throw new VaultNotWiredError("Protected passkey is unavailable or its format is unsupported");
  }
}

/**
 * Consumer for a single host-owned, startup-resolved config leaf, not a store resolver.
 * The trusted host callback must enforce capability availability on every call and return
 * the current resolved plugin config value. Never bind this callback to CLI/env/file reads.
 */
export function createResolvedPasskeyLoader(binding: {
  reference: string;
  readResolvedValue: () => unknown;
  legacyHandleEncoding?: LegacyHandleEncoding;
}): SecretLoader {
  return {
    async loadPasskey(reference) {
      if (reference !== binding.reference) throw new VaultNotWiredError("Passkey reference is not bound");
      try {
        return normalizeResolvedPasskey(binding.readResolvedValue(), binding.legacyHandleEncoding);
      } catch {
        throw new VaultNotWiredError("Protected passkey consumer is unavailable");
      }
    },
  };
}
