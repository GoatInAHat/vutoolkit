import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runSetup, type RunDeps } from "./setup-run.js";
import type { VaultPasskey } from "./ceremony.js";
import type { CdpTab } from "./cdp-driver.js";
import { AuthError } from "./errors.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credential: VaultPasskey = {
  credentialId: Buffer.from("synthetic-new-key").toString("base64"),
  privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  userHandle: Buffer.from("synthetic-user").toString("base64"),
  rpId: "onevu.vanderbilt.edu", signCount: 0,
};

function harness(opts: { signedIn?: boolean; existing?: string; pending?: string; password?: string } = {}) {
  const vault = new Map<string, string>([["VANDERBILT_EMAIL", "synthetic@vanderbilt.edu"]]);
  if (opts.existing) vault.set("VANDERBILT_PASSKEY", opts.existing);
  if (opts.pending) vault.set("VANDERBILT_PASSKEY_PENDING", opts.pending);
  if (opts.password) vault.set("VANDERBILT_PASSWORD", opts.password);
  const calls: string[] = [];
  let clock = 0;
  let enrollmentStarted = false;
  const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
    calls.push(expression);
    if (expression.includes("const body =")) return { url: "https://onevu.vanderbilt.edu/account-settings/security", security: opts.signedIn !== false,
      identifier: opts.signedIn === false, password: false, challenge: false, error: false };
    if (expression.includes("button.click()")) { enrollmentStarted = true; return true; }
    if (expression.includes("enrolledCount:")) return { authenticated: opts.signedIn !== false, identityMatched: opts.signedIn !== false,
      enrollmentAvailable: opts.signedIn !== false, enrolledCount: enrollmentStarted ? 2 : 1 };
    return false;
  });
  const send = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "synthetic-authenticator" };
    if (method === "WebAuthn.getCredentials") return { credentials: enrollmentStarted ? [credential] : [] };
    return {};
  });
  const ensure = vi.fn(async () => ({ source: "minted" as const, healthy: true }));
  const deps: RunDeps = {
    env: { VUTOOLKIT_CDP_URL: "http://127.0.0.1:18800", VUTOOLKIT_CREDENTIAL_STORE: "file" },
    read: (name) => { const value = vault.get(name); if (!value) throw new Error("missing"); return value; },
    write: (name, value) => { vault.set(name, value); },
    browserReady: async () => {},
    now: () => clock, wait: async (ms) => { clock += ms; }, ensure,
    verifyPasskey: async () => true,
    tab: (async (_url, _start, fn) => fn({ tabId: "synthetic-tab", send: send as CdpTab["send"], evaluate })) as RunDeps["tab"],
  };
  return { deps, vault, calls, send, ensure };
}

const dir = () => mkdtempSync(join(tmpdir(), "vutoolkit-setup-run-"));

describe("setup.run", () => {
  it("requires account-holder authorization and configured identity", async () => {
    const h = harness();
    await expect(runSetup(dir(), { confirm: false }, h.deps)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    h.vault.delete("VANDERBILT_EMAIL");
    await expect(runSetup(dir(), { confirm: true }, h.deps)).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
  });

  it("enrolls from an already-authenticated shared browser without a password or phone prompt", async () => {
    const h = harness({ signedIn: true });
    const result = await runSetup(dir(), { confirm: true, allowInteractiveVerification: false }, h.deps);
    expect(result).toMatchObject({ status: "ready", passkey: "enrolled", vanderbiltSession: "ready" });
    expect(h.vault.has("VANDERBILT_PASSKEY")).toBe(true);
    expect(h.vault.get("VANDERBILT_PASSKEY")).toBe(h.vault.get("VANDERBILT_PASSKEY_PENDING"));
    expect(h.calls.some((expression) => expression.includes("return (sel,val)=>"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential.privateKey);
  });

  it("never submits identifier/password or triggers MFA when existing-session-only is requested", async () => {
    const h = harness({ signedIn: false, password: "synthetic-not-real" });
    await expect(runSetup(dir(), { confirm: true, allowInteractiveVerification: false, timeoutSeconds: 15 }, h.deps))
      .rejects.toMatchObject({ code: "EXISTING_SESSION_REQUIRED" });
    expect(h.calls.some((expression) => expression.includes("synthetic-not-real"))).toBe(false);
    expect(h.vault.has("VANDERBILT_PASSKEY")).toBe(false);
  });

  it("submits each login stage once and leaves one-time phone verification to the holder", async () => {
    const h = harness({ signedIn: false, password: "synthetic-not-real" });
    let stage = 0;
    let identifierSubmits = 0;
    let passwordSubmits = 0;
    const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
      if (expression.includes("const body =")) return { url: "https://onevu.vanderbilt.edu/login", security: false,
        identifier: stage === 0, password: stage === 1, challenge: stage === 2, error: false };
      if (expression.includes("return (")) {
        if (expression.includes("input[type=\"password\"]")) return true;
        if (expression.includes("input[name=\"identifier\"]")) return true;
      }
      if (expression.includes("input[type=\"submit\"]")) {
        if (stage === 0) { identifierSubmits++; stage = 1; }
        else if (stage === 1) { passwordSubmits++; stage = 2; }
        return true;
      }
      return false;
    });
    h.deps.tab = (async (_url, _start, fn) => fn({ tabId: "synthetic-tab", send: (async () => ({})) as CdpTab["send"], evaluate })) as RunDeps["tab"];
    await expect(runSetup(dir(), { confirm: true, timeoutSeconds: 15 }, h.deps)).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect(identifierSubmits).toBe(1);
    expect(passwordSubmits).toBe(1);
  });

  it("fills both fields before one submit on a combined identifier/password form", async () => {
    const h = harness({ signedIn: false, password: "synthetic-not-real" });
    let challenged = false;
    const steps: string[] = [];
    const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
      if (expression.includes("const body =")) return { url: "https://onevu.vanderbilt.edu/login", security: false,
        identifier: !challenged, password: !challenged, challenge: challenged, error: false };
      if (expression.includes("input[name=\"identifier\"]',")) { steps.push("identifier"); return true; }
      if (expression.includes("input[type=\"password\"]',")) { steps.push("password"); return true; }
      if (expression.includes("input[type=\"submit\"]")) { steps.push("submit"); challenged = true; return true; }
      return false;
    });
    h.deps.tab = (async (_url, _start, fn) => fn({ tabId: "synthetic-tab", send: (async () => ({})) as CdpTab["send"], evaluate })) as RunDeps["tab"];
    await expect(runSetup(dir(), { confirm: true, timeoutSeconds: 15 }, h.deps)).rejects.toMatchObject({ code: "MFA_REQUIRED" });
    expect(steps).toEqual(["identifier", "password", "submit"]);
  });

  it("does not create a duplicate credential when a prior enrollment is pending", async () => {
    const h = harness({ pending: JSON.stringify(credential) });
    await expect(runSetup(dir(), { confirm: true }, h.deps)).rejects.toMatchObject({ code: "PENDING_ENROLLMENT" });
    expect(h.calls).toEqual([]);
  });

  it("reuses an existing working key without rotating it", async () => {
    const h = harness({ existing: JSON.stringify(credential) });
    const result = await runSetup(dir(), { confirm: true }, h.deps);
    expect(result.passkey).toBe("existing");
    expect(h.vault.get("VANDERBILT_PASSKEY_PREVIOUS")).toBeUndefined();
    expect(h.calls).toEqual([]);
    expect(h.ensure).toHaveBeenCalledTimes(1);
  });

  it("preserves typed browser failures and reports Microsoft failure as partial", async () => {
    const h = harness({ existing: JSON.stringify(credential) });
    h.deps.ensure = async (idp) => {
      if (idp === "microsoft") throw new Error("synthetic Microsoft failure");
      return { source: "cache", healthy: true };
    };
    const partial = await runSetup(dir(), { confirm: true }, h.deps);
    expect(partial).toMatchObject({ status: "partial", microsoftSession: "not-ready" });
    h.deps.browserReady = async () => { throw new AuthError("BROWSER_UNAVAILABLE", "selected browser unavailable", { retryable: true }); };
    await expect(runSetup(dir(), { confirm: true }, h.deps)).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
  });

  it("recovers the rejected key using the active browser, preserving the old vault entry", async () => {
    const old = JSON.stringify({ ...credential, credentialId: Buffer.from("synthetic-old-key").toString("base64") });
    const h = harness({ signedIn: true, existing: old, pending: old });
    const result = await runSetup(dir(), { confirm: true, recovery: true, allowInteractiveVerification: false }, h.deps);
    expect(result.passkey).toBe("recovered");
    expect(h.vault.get("VANDERBILT_PASSKEY_PREVIOUS")).toBe(old);
    expect(h.vault.get("VANDERBILT_PASSKEY")).not.toBe(old);
    expect(h.send.mock.calls.map(([method]) => method)).not.toContain("WebAuthn.addCredential");
  });
});
