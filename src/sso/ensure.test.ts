import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../vault/file-store.js";
import { VaultNotWiredError } from "../vault/index.js";
import { classifyOktaFlow, isLoginSuccess, toCdpB64, type MintedSession } from "./ceremony.js";
import { AuthError, withDeadline } from "./errors.js";
import { MicrosoftNotConfiguredError, type MintedMicrosoftSession } from "./microsoft.js";
import { ensureSession, parseVaultPasskey, type EnsureDeps } from "./ensure.js";

const dirs: string[] = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vutoolkit-ensure-"));
  dirs.push(dir);
  return new FileSessionStore(join(dir, "sessions.vault.json"));
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const NOW = new Date("2026-09-15T12:00:00.000Z");
const HOUR_AGO = new Date(NOW.getTime() - 3600_000).toISOString();
const IN_A_YEAR = new Date(NOW.getTime() + 365 * 86400_000).toISOString();
const PASSKEY = { credentialId: "abc", privateKey: "def", userHandle: "dXNlcg", rpId: "vanderbilt.edu", signCount: 666 };
function minted(cookies = [{ name: "idx", value: "v", domain: "onevu.vanderbilt.edu" }]): MintedSession {
  return { cookies, acquiredAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), finalUrl: "https://onevu.vanderbilt.edu/app/UserHome", signCountUsed: 667 };
}
function mintedMicrosoft(): MintedMicrosoftSession {
  return {
    cookies: [
      { name: "MSAL", value: "x", domain: "login.microsoftonline.com" },
      { name: "OIDC", value: "y", domain: "outlook.office.com" },
    ],
    acquiredAt: NOW.toISOString(),
    finalUrl: "https://outlook.office.com/mail/",
  };
}
const DEPS: EnsureDeps = {
  ceremony: async () => minted(),
  secretsRead: (name: string) => (name === "VANDERBILT_EMAIL" ? "bennett.g.vernon@vanderbilt.edu" : JSON.stringify(PASSKEY)),
  ensureBrowser: async () => {},
  probe: async () => true,
  env: {},
  now: () => NOW,
  retryDelayMs: 0,
};

describe("ensureSession", () => {
  it("returns a just-acquired cached session without probing or minting", async () => {
    const store = freshStore();
    await store.put({ idp: "vanderbilt", acquiredAt: NOW.toISOString(), expiresAt: IN_A_YEAR, healthy: true, cookieHeader: "idx=v" });
    let ceremonyCalls = 0;
    const result = await ensureSession("vanderbilt", store, {
      ...DEPS,
      ceremony: async () => { ceremonyCalls++; return minted(); },
      probe: async () => { throw new Error("must not probe a just-acquired session"); },
    });
    expect(result.source).toBe("cache");
    expect(ceremonyCalls).toBe(0);
  });

  it("serves an older session from cache when the liveness probe proves it alive, keeping its cookies", async () => {
    const store = freshStore();
    await store.put({ idp: "vanderbilt", acquiredAt: HOUR_AGO, expiresAt: IN_A_YEAR, healthy: false, cookieHeader: "idx=v", cookies: [{ name: "idx", value: "v", domain: "onevu.vanderbilt.edu" }] });
    let probed = 0;
    const result = await ensureSession("vanderbilt", store, {
      ...DEPS,
      ceremony: async () => { throw new Error("must not mint a live session"); },
      probe: async () => { probed++; return true; },
    });
    expect(result).toMatchObject({ source: "cache", healthy: true });
    expect(probed).toBe(1);
    expect(store.cookies("vanderbilt")).toHaveLength(1);
    expect((await store.get("vanderbilt"))?.healthy).toBe(true);
  });

  it("re-mints a dead session whose cookies have not expired", async () => {
    const store = freshStore();
    await store.put({ idp: "vanderbilt", acquiredAt: HOUR_AGO, expiresAt: IN_A_YEAR, healthy: true, cookieHeader: "stale=1" });
    const result = await ensureSession("vanderbilt", store, { ...DEPS, probe: async () => false });
    expect(result.source).toBe("minted");
    expect((await store.get("vanderbilt"))?.cookieHeader).toBe("idx=v");
  });

  it("mints when no session exists, caches it, and the next ensure is a cache hit", async () => {
    const store = freshStore();
    const first = await ensureSession("vanderbilt", store, DEPS);
    expect(first.source).toBe("minted");
    expect(first.healthy).toBe(true);
    const cached = await ensureSession("vanderbilt", store, { ...DEPS, ceremony: async () => { throw new Error("must not mint twice"); } });
    expect(cached.source).toBe("cache");
  });

  it("mints over an expired session", async () => {
    const store = freshStore();
    await store.put({ idp: "vanderbilt", acquiredAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() - 1000).toISOString(), healthy: true, cookieHeader: "old=1" });
    const result = await ensureSession("vanderbilt", store, DEPS);
    expect(result.source).toBe("minted");
    const got = await store.get("vanderbilt");
    expect(got?.cookieHeader).toBe("idx=v");
  });

  it("fails closed on a harvest without IdP cookies, without retrying", async () => {
    const store = freshStore();
    let calls = 0;
    await expect(ensureSession("vanderbilt", store, {
      ...DEPS,
      ceremony: async () => { calls++; return minted([{ name: "SID", value: "x", domain: ".google.com" }]); },
    })).rejects.toThrow(VaultNotWiredError);
    expect(calls).toBe(1);
  });

  it("starts the browser before a ceremony", async () => {
    const store = freshStore();
    const order: string[] = [];
    await ensureSession("vanderbilt", store, {
      ...DEPS,
      ensureBrowser: async () => { order.push("browser"); },
      ceremony: async () => { order.push("ceremony"); return minted(); },
    });
    expect(order).toEqual(["browser", "ceremony"]);
  });

  it("retries a transient ceremony failure once", async () => {
    const store = freshStore();
    let calls = 0;
    const result = await ensureSession("vanderbilt", store, {
      ...DEPS,
      ceremony: async () => {
        calls++;
        if (calls === 1) throw new AuthError("OKTA_FLOW_CHANGED", "slow page", { retryable: true });
        return minted();
      },
    });
    expect(result.source).toBe("minted");
    expect(calls).toBe(2);
  });

  it("surfaces the typed error when the retry fails too", async () => {
    const store = freshStore();
    let calls = 0;
    const failure = ensureSession("vanderbilt", store, {
      ...DEPS,
      ensureBrowser: async () => { calls++; throw new AuthError("BROWSER_UNAVAILABLE", "down", { retryable: true }); },
    });
    await expect(failure).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    expect(calls).toBe(2);
  });

  it("does not retry a missing vault secret", async () => {
    const store = freshStore();
    let reads = 0;
    await expect(ensureSession("vanderbilt", store, {
      ...DEPS,
      secretsRead: () => { reads++; throw new AuthError("VAULT_SECRET_UNAVAILABLE", "missing", { retryable: false }); },
    })).rejects.toMatchObject({ code: "VAULT_SECRET_UNAVAILABLE" });
    expect(reads).toBe(1);
  });

  it("shares one mint between concurrent ensure calls", async () => {
    const store = freshStore();
    let calls = 0;
    const deps: EnsureDeps = {
      ...DEPS,
      ceremony: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return minted(); },
    };
    const [a, b] = await Promise.all([ensureSession("vanderbilt", store, deps), ensureSession("vanderbilt", store, deps)]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("bounds the whole call with a TIMEOUT error", async () => {
    const store = freshStore();
    await expect(ensureSession("vanderbilt", store, {
      ...DEPS,
      deadlineMs: 30,
      ceremony: () => new Promise<MintedSession>((resolve) => setTimeout(() => resolve(minted()), 300)),
    })).rejects.toMatchObject({ code: "TIMEOUT" });
    // Let the slow ceremony settle so the process-wide ceremony queue is free for later tests.
    await new Promise((r) => setTimeout(r, 350));
  });

  it("microsoft mints through the Entra-carry ceremony, then serves cache", async () => {
    const store = freshStore();
    const result = await ensureSession("microsoft", store, { ...DEPS, microsoftCeremony: async () => mintedMicrosoft() });
    expect(result.source).toBe("minted");
    expect(result.healthy).toBe(true);
    // The outlook RP cookie must survive vault scoping alongside the IdP cookies.
    const got = await store.get("microsoft");
    expect(got?.cookieHeader).toContain("MSAL=x");
    expect(got?.cookieHeader).toContain("OIDC=y");
    const again = await ensureSession("microsoft", store, {
      ...DEPS,
      microsoftCeremony: async () => {
        throw new Error("should not re-mint while the cache is fresh");
      },
    });
    expect(again.source).toBe("cache");
  });

  it("microsoft signs the browser into OneVU and carries again when federation needs an Okta session", async () => {
    const store = freshStore();
    const order: string[] = [];
    let carries = 0;
    const result = await ensureSession("microsoft", store, {
      ...DEPS,
      ceremony: async () => { order.push("onevu"); return minted(); },
      microsoftCeremony: async () => {
        carries++;
        order.push(`carry${carries}`);
        if (carries === 1) throw new AuthError("OKTA_SESSION_REQUIRED", "federated to OneVU", { retryable: true });
        return mintedMicrosoft();
      },
    });
    expect(result.source).toBe("minted");
    expect(order).toEqual(["carry1", "onevu", "carry2"]);
    expect((await store.get("vanderbilt"))?.cookieHeader).toBe("idx=v");
  });

  it("microsoft refuses loudly at a Microsoft password prompt, without retrying", async () => {
    const store = freshStore();
    let carries = 0;
    await expect(
      ensureSession("microsoft", store, {
        ...DEPS,
        microsoftCeremony: async () => {
          carries++;
          throw new MicrosoftNotConfiguredError("microsoft mint: password prompt");
        },
      }),
    ).rejects.toThrow(MicrosoftNotConfiguredError);
    expect(carries).toBe(1);
  });

  it("secret names come from the vault contract; env overrides win", async () => {
    const store = freshStore();
    const seen: string[] = [];
    await ensureSession("vanderbilt", store, {
      ...DEPS,
      ceremony: async (opts) => {
        expect(opts.email).toBe("env@vanderbilt.edu");
        return minted();
      },
      secretsRead: (name) => { seen.push(name); return name === "VANDERBILT_EMAIL" ? "vault@vanderbilt.edu" : JSON.stringify(PASSKEY); },
      env: { VUTOOLKIT_VU_EMAIL: "env@vanderbilt.edu" },
    });
    expect(seen).toEqual(["VANDERBILT_PASSKEY"]);
  });
});

describe("ceremony pure helpers", () => {
  it("classifies login success exactly like the proven sweep", () => {
    expect(isLoginSuccess("https://onevu.vanderbilt.edu/app/UserHome")).toBe(true);
    expect(isLoginSuccess("https://onevu.vanderbilt.edu/enduser/")).toBe(false);
    expect(isLoginSuccess("https://landing.app.vanderbilt.edu/landing/student-landing")).toBe(true);
    expect(isLoginSuccess("about:blank")).toBe(false);
    expect(isLoginSuccess("https://login.microsoftonline.com/authorize?x=1")).toBe(false);
  });

  it("classifies the OneVU page: success, then Okta's error, then passkey choice, then identifier", () => {
    const base = { url: "https://onevu.vanderbilt.edu/", identifier: false, webauthn: false, error: "" };
    expect(classifyOktaFlow({ ...base, url: "https://onevu.vanderbilt.edu/app/UserHome", identifier: true }).kind).toBe("success");
    expect(classifyOktaFlow({ ...base, error: "Unable to sign in", webauthn: true })).toEqual({ kind: "error", message: "Unable to sign in" });
    expect(classifyOktaFlow({ ...base, webauthn: true, identifier: true }).kind).toBe("webauthn");
    expect(classifyOktaFlow({ ...base, identifier: true }).kind).toBe("identifier");
    expect(classifyOktaFlow(base).kind).toBe("wait");
  });

  it("pads base64url for CDP addCredential", () => {
    expect(toCdpB64("abc")).toBe("abc=");
    expect(toCdpB64("abcd")).toBe("abcd");
    expect(toCdpB64("a-b_c")).toBe("a+b/c===");
  });

  it("parseVaultPasskey rejects bad shapes without echoing values", async () => {
    expect(() => parseVaultPasskey("{")).toThrow(VaultNotWiredError);
    expect(() => parseVaultPasskey(JSON.stringify({ credentialId: "a" }))).toThrow(VaultNotWiredError);
    const ok = parseVaultPasskey(JSON.stringify(PASSKEY));
    expect(ok.rpId).toBe("vanderbilt.edu");
  });

  it("withDeadline passes results through and names the step on timeout", async () => {
    await expect(withDeadline(Promise.resolve(7), 50, "step")).resolves.toBe(7);
    await expect(withDeadline(new Promise(() => {}), 10, "slow step")).rejects.toThrow("[TIMEOUT] slow step");
  });
});
