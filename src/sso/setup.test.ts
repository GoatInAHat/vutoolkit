import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { advancePasskeyCounter, configureIdentity, enrollSetup, prepareSetup, setupStatus, type SetupDeps } from "./setup.js";
import type { VaultPasskey } from "./ceremony.js";
import type { CdpTab } from "./cdp-driver.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credential: VaultPasskey = {
  credentialId: Buffer.from("synthetic-credential").toString("base64"),
  privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  userHandle: Buffer.from("synthetic-user").toString("base64"),
  rpId: "onevu.vanderbilt.edu", signCount: 0, isResidentCredential: true,
};

function harness(options: { existing?: string; signedIn?: boolean; identityMatched?: boolean; acknowledge?: boolean; corruptReadback?: boolean; failWriteName?: string } = {}) {
  const vault = new Map<string, string>([["VANDERBILT_EMAIL", "synthetic@vanderbilt.edu"]]);
  if (options.existing) vault.set("VANDERBILT_PASSKEY", options.existing);
  let clock = 0;
  let started = false;
  const calls: string[] = [];
  const page = () => ({ authenticated: options.signedIn !== false, identityMatched: options.identityMatched ?? options.signedIn !== false, enrollmentAvailable: options.signedIn !== false,
    enrolledCount: started && options.acknowledge !== false ? 2 : 1, signInRequired: options.signedIn === false });
  const send = vi.fn(async (method: string) => {
    calls.push(method);
    if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "synthetic-authenticator" };
    if (method === "WebAuthn.getCredentials") return { credentials: started ? [credential] : [] };
    return {};
  });
  const evaluate = vi.fn(async (expression: string) => {
    if (expression.includes("button.click()")) { started = true; return true; }
    if (expression.includes("enrolledCount:")) return page();
    return false;
  });
  const write = vi.fn((name: string, value: string) => {
    if (name === options.failWriteName) throw new Error("synthetic vault write failure");
    vault.set(name, options.corruptReadback ? "invalid" : value);
  });
  const deps: SetupDeps = {
    env: {},
    read: (name) => { const value = vault.get(name); if (!value) throw new Error("missing"); return value; },
    write, reachable: async () => true, browserReady: async () => {},
    wait: async (ms) => { clock += ms; }, now: () => clock,
    tab: (async (_url, _start, fn) => fn({ tabId: "synthetic-tab", send: send as CdpTab["send"], evaluate })) as SetupDeps["tab"],
  };
  return { deps, write, calls, vault, evaluate };
}

describe("OneVU setup", () => {
  it("persists only an observed advancing assertion counter with vault readback", () => {
    const raw = JSON.stringify(credential);
    const h = harness({ existing: raw });
    advancePasskeyCounter(raw, 2, h.deps);
    expect(JSON.parse(h.vault.get("VANDERBILT_PASSKEY")!).signCount).toBe(2);
    expect(() => advancePasskeyCounter(raw, 3, h.deps)).toThrow(/CREDENTIAL_CHANGED/);
    expect(() => advancePasskeyCounter(h.vault.get("VANDERBILT_PASSKEY")!, 2, h.deps)).toThrow(/PASSKEY_COUNTER_INVALID/);
  });
  it("accepts VUnetID-only setup without accepting a secret or switching a configured account", () => {
    const h = harness();
    expect(configureIdentity({ vunetId: "synthetic" }, h.deps).emailDerivedFromVunetId).toBe(true);
    expect(h.vault.get("VANDERBILT_EMAIL")).toBe("synthetic@vanderbilt.edu");
    const existing = harness({ existing: JSON.stringify(credential) });
    expect(() => configureIdentity({ email: "different@vanderbilt.edu" }, existing.deps)).toThrow(/existing passkey/i);
    expect(existing.write).not.toHaveBeenCalled();
  });
  it("validates existing material and reports metadata only", async () => {
    const h = harness({ existing: JSON.stringify(credential) });
    const result = await setupStatus(h.deps);
    expect(result.readyForAuth).toBe(true);
    expect(result.passkeyValid).toBe(true);
    expect(JSON.stringify(result).includes(credential.privateKey)).toBe(false);
    expect(JSON.stringify(result).includes("synthetic@vanderbilt.edu")).toBe(false);
  });

  it("does not treat malformed or foreign-relying-party material as ready", async () => {
    const h = harness({ existing: JSON.stringify({ ...credential, rpId: "vanderbilt.edu.attacker.example" }) });
    const result = await setupStatus(h.deps);
    expect(result.passkeyConfigured).toBe(true);
    expect(result.passkeyValid).toBe(false);
    expect(result.readyForAuth).toBe(false);
  });

  it("prepares and removes its virtual authenticator without issuing or writing a key", async () => {
    const h = harness({ existing: JSON.stringify(credential) });
    const result = await prepareSetup({ keepTab: false }, h.deps);
    expect(result.status).toBe("ready");
    expect(result.existingPasskeyPreserved).toBe(true);
    expect(result.browserTabId).toBeUndefined();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.calls).toContain("WebAuthn.removeVirtualAuthenticator");
    expect(h.evaluate.mock.calls.some(([expression]) => expression.includes("button.click()"))).toBe(false);
  });

  it("requires explicit confirmation and refuses to replace any existing entry", async () => {
    await expect(enrollSetup({ confirm: false }, harness().deps)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const h = harness({ existing: "malformed-but-preserved" });
    await expect(enrollSetup({ confirm: true }, h.deps)).rejects.toMatchObject({ code: "EXISTING_PASSKEY" });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });

  it("recovers a rejected but structurally valid key by staging the new key, verifying it, backing up the old key, then promoting", async () => {
    const previousPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const previous: VaultPasskey = { ...credential,
      credentialId: Buffer.from("old-synthetic-credential").toString("base64"),
      privateKey: previousPair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    };
    const oldRaw = JSON.stringify(previous);
    const h = harness({ existing: oldRaw });
    const result = await enrollSetup({ confirm: true, replaceExisting: true }, h.deps);
    expect(result).toMatchObject({ status: "enrolled", serverConfirmed: true });
    expect(h.vault.get("VANDERBILT_PASSKEY_PREVIOUS")).toBe(oldRaw);
    expect(JSON.parse(h.vault.get("VANDERBILT_PASSKEY")!).credentialId).toBe(credential.credentialId);
    expect(JSON.parse(h.vault.get("VANDERBILT_PASSKEY_PENDING")!).credentialId).toBe(credential.credentialId);
    expect(h.write.mock.calls.map(([name]) => name)).toEqual([
      "VANDERBILT_PASSKEY_PENDING", "VANDERBILT_PASSKEY_PREVIOUS", "VANDERBILT_PASSKEY",
    ]);
    expect(JSON.stringify(result)).not.toContain(credential.privateKey);
  });

  it("does not promote if the recovery backup slot is already occupied", async () => {
    const h = harness({ existing: JSON.stringify(credential) });
    h.vault.set("VANDERBILT_PASSKEY_PREVIOUS", "already-preserved");
    await expect(enrollSetup({ confirm: true, replaceExisting: true }, h.deps)).rejects.toMatchObject({ code: "BACKUP_EXISTS" });
    expect(h.vault.get("VANDERBILT_PASSKEY")).toBe(JSON.stringify(credential));
    expect(h.calls).toEqual([]);
  });

  it("submits a passkey enrollment continuation at most once while awaiting server acknowledgement", async () => {
    const h = harness({ acknowledge: false });
    let continuationClicks = 0;
    const original = h.evaluate.getMockImplementation()!;
    h.evaluate.mockImplementation(async (expression: string) => {
      if (expression.includes("choices[0].click()")) { continuationClicks++; return true; }
      return original(expression);
    });
    const result = await enrollSetup({ confirm: true, timeoutSeconds: 4 }, h.deps);
    expect(result.status).toBe("stored-awaiting-confirmation");
    expect(continuationClicks).toBe(1);
  });

  it("does not promote a new key when staged vault readback is corrupt", async () => {
    const oldRaw = JSON.stringify(credential);
    const h = harness({ existing: oldRaw, corruptReadback: true });
    await expect(enrollSetup({ confirm: true, replaceExisting: true }, h.deps)).rejects.toMatchObject({ code: "VAULT_VERIFY_FAILED" });
    expect(h.vault.get("VANDERBILT_PASSKEY")).toBe(oldRaw);
    expect(h.vault.has("VANDERBILT_PASSKEY_PREVIOUS")).toBe(false);
  });

  it("preserves the prior active key if the final promotion write fails", async () => {
    const oldRaw = JSON.stringify({ ...credential, credentialId: Buffer.from("previous-active").toString("base64") });
    const h = harness({ existing: oldRaw, failWriteName: "VANDERBILT_PASSKEY" });
    await expect(enrollSetup({ confirm: true, replaceExisting: true }, h.deps)).rejects.toThrow(/synthetic vault write failure/);
    expect(h.vault.get("VANDERBILT_PASSKEY")).toBe(oldRaw);
    expect(h.vault.get("VANDERBILT_PASSKEY_PREVIOUS")).toBe(oldRaw);
    expect(h.vault.has("VANDERBILT_PASSKEY_PENDING")).toBe(true);
  });

  it("does not begin enrollment before authenticated settings are available", async () => {
    const h = harness({ signedIn: false });
    await expect(enrollSetup({ confirm: true }, h.deps)).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("WebAuthn.addVirtualAuthenticator");
  });

  it("blocks enrollment when the authenticated page cannot confirm the configured email", async () => {
    const h = harness({ identityMatched: false });
    await expect(enrollSetup({ confirm: true }, h.deps)).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    expect(h.calls).not.toContain("WebAuthn.addVirtualAuthenticator");
    expect(h.write).not.toHaveBeenCalled();
  });

  it("directs recovery to the same OpenClaw-managed tab without loading the rejected key", async () => {
    const h = harness({ existing: JSON.stringify(credential), signedIn: false });
    const status = await setupStatus(h.deps);
    expect(status.browserAvailable).toBe(true);
    expect(status.readyForAuth).toBe(true);
    const prepared = await prepareSetup({ recovery: true }, h.deps);
    expect(prepared.status).toBe("sign-in-required");
    expect(prepared.nextStep).toMatch(/Control UI.*Browser panel.*openclaw profile/i);
    expect(h.calls).not.toContain("WebAuthn.addCredential");
    h.deps.reachable = async () => false;
    const unavailable = await setupStatus(h.deps);
    expect(unavailable.readyForAuth).toBe(false);
    expect(unavailable.nextStep).toMatch(/browser is unavailable/i);
  });

  it("writes only to the vault and requires a server-acknowledged additional enrollment", async () => {
    const h = harness();
    const result = await enrollSetup({ confirm: true }, h.deps);
    expect(result.status).toBe("enrolled");
    expect(result.serverConfirmed).toBe(true);
    expect(result.existingPasskeysRevoked).toBe(false);
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result).includes(credential.privateKey)).toBe(false);
    expect(h.calls).toContain("WebAuthn.removeVirtualAuthenticator");
  });

  it("preserves a vaulted new credential without claiming server acceptance when confirmation is missing", async () => {
    const h = harness({ acknowledge: false });
    const result = await enrollSetup({ confirm: true, timeoutSeconds: 2 }, h.deps);
    expect(result.status).toBe("stored-awaiting-confirmation");
    expect(result.serverConfirmed).toBe(false);
    expect(h.vault.has("VANDERBILT_PASSKEY_PENDING")).toBe(true);
    expect(h.vault.has("VANDERBILT_PASSKEY")).toBe(false);
  });
});
