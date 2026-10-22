import { generateKeyPairSync } from "node:crypto";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { configureIdentity } from "./setup.js";
import { runSetup, type RunDeps } from "./setup-run.js";
import type { VaultPasskey } from "./ceremony.js";
import type { CdpTab } from "./cdp-driver.js";

const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credential: VaultPasskey = {
  credentialId: Buffer.from("synthetic-guided-key").toString("base64"),
  privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  userHandle: Buffer.from("synthetic-guided-user").toString("base64"),
  rpId: "onevu.vanderbilt.edu", signCount: 0,
};

function harness() {
  const vault = new Map<string, string>();
  let clock = 0;
  let enrollmentStarted = false;
  const evaluate = vi.fn(async (expression: string): Promise<unknown> => {
    if (expression.includes("const body =")) return { url: "https://onevu.vanderbilt.edu/account-settings/security", security: true,
      identifier: false, password: false, challenge: false, error: false };
    if (expression.includes("button.click()")) { enrollmentStarted = true; return true; }
    if (expression.includes("enrolledCount:")) return { authenticated: true, identityMatched: true,
      enrollmentAvailable: true, enrolledCount: enrollmentStarted ? 2 : 1 };
    return false;
  });
  const send = vi.fn(async (method: string): Promise<unknown> => {
    if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "synthetic-guided-authenticator" };
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
    tab: (async (_url, _start, fn) => fn({ tabId: "synthetic-guided-tab", send: send as CdpTab["send"], evaluate })) as RunDeps["tab"],
  };
  return { deps, vault };
}

const dir = () => mkdtempSync(join(tmpdir(), "vutoolkit-setup-guided-flow-"));

describe("guided passkey issuance flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("configures identity, enrolls, and completes a verified SSO login with no secret leakage", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeFileSync = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const appendFileSync = vi.spyOn(fs, "appendFileSync").mockImplementation(() => undefined);

    const h = harness();
    expect(h.vault.has("VANDERBILT_EMAIL")).toBe(false);
    expect(h.vault.has("VANDERBILT_PASSKEY")).toBe(false);

    const identity = configureIdentity({ vunetId: "synthetic123" }, h.deps);
    expect(identity).toMatchObject({ identityConfigured: true, emailDerivedFromVunetId: true });
    expect(h.vault.get("VANDERBILT_EMAIL")).toBe("synthetic123@vanderbilt.edu");

    const result = await runSetup(dir(), { confirm: true, allowInteractiveVerification: false }, h.deps);
    expect(result).toMatchObject({
      status: "ready",
      passkey: "enrolled",
      passkeyAssertion: "verified",
      vanderbiltSession: "ready",
    });
    expect(h.vault.has("VANDERBILT_PASSKEY")).toBe(true);
    expect(h.vault.get("VANDERBILT_PASSKEY")).toBe(h.vault.get("VANDERBILT_PASSKEY_PENDING"));
    expect(JSON.stringify(result)).not.toContain(credential.privateKey);

    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(appendFileSync).not.toHaveBeenCalled();
  });
});
