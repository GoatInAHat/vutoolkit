import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { configureIdentity, enrollSetup, prepareSetup, setupStatus, type SetupDeps } from "./setup.js";
import type { VaultPasskey } from "./ceremony.js";
import type { CdpTab } from "./cdp-driver.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credential: VaultPasskey = {
  credentialId: Buffer.from("synthetic-credential").toString("base64"),
  privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  userHandle: Buffer.from("synthetic-user").toString("base64"),
  rpId: "onevu.vanderbilt.edu", signCount: 0, isResidentCredential: true,
};

function harness(options: { existing?: string; signedIn?: boolean; acknowledge?: boolean; corruptReadback?: boolean } = {}) {
  const vault = new Map<string, string>([["VANDERBILT_EMAIL", "synthetic@vanderbilt.edu"]]);
  if (options.existing) vault.set("VANDERBILT_PASSKEY", options.existing);
  let clock = 0;
  let started = false;
  const calls: string[] = [];
  const page = () => ({ authenticated: options.signedIn !== false, enrollmentAvailable: options.signedIn !== false,
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
  const write = vi.fn((name: string, value: string) => vault.set(name, options.corruptReadback ? "invalid" : value));
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

  it("does not begin enrollment before authenticated settings are available", async () => {
    const h = harness({ signedIn: false });
    await expect(enrollSetup({ confirm: true }, h.deps)).rejects.toMatchObject({ code: "SIGN_IN_REQUIRED" });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("WebAuthn.addVirtualAuthenticator");
  });

  it("writes only to the vault and requires a server-acknowledged additional enrollment", async () => {
    const h = harness();
    const result = await enrollSetup({ confirm: true }, h.deps);
    expect(result.status).toBe("enrolled");
    expect(result.serverConfirmed).toBe(true);
    expect(result.existingPasskeysRevoked).toBe(false);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result).includes(credential.privateKey)).toBe(false);
    expect(h.calls).toContain("WebAuthn.removeVirtualAuthenticator");
  });

  it("preserves a vaulted new credential without claiming server acceptance when confirmation is missing", async () => {
    const h = harness({ acknowledge: false });
    const result = await enrollSetup({ confirm: true, timeoutSeconds: 2 }, h.deps);
    expect(result.status).toBe("stored-awaiting-confirmation");
    expect(result.serverConfirmed).toBe(false);
    expect(h.vault.has("VANDERBILT_PASSKEY")).toBe(true);
  });
});
