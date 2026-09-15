import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../vault/file-store.js";
import { VaultNotWiredError } from "../vault/index.js";
import { isLoginSuccess, toCdpB64, type MintedSession } from "./ceremony.js";
import { ensureSession, parseVaultPasskey } from "./ensure.js";

const dirs: string[] = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vutoolkit-ensure-"));
  dirs.push(dir);
  return new FileSessionStore(join(dir, "sessions.vault.json"));
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const NOW = new Date("2026-09-15T12:00:00.000Z");
const PASSKEY = { credentialId: "abc", privateKey: "def", userHandle: "dXNlcg", rpId: "vanderbilt.edu", signCount: 666 };
function minted(cookies = [{ name: "idx", value: "v", domain: "onevu.vanderbilt.edu" }]): MintedSession {
  return { cookies, acquiredAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), finalUrl: "https://onevu.vanderbilt.edu/app/UserHome", signCountUsed: 667 };
}
const DEPS = {
  ceremony: async () => minted(),
  secretsRead: (name: string) => (name === "VANDERBILT_EMAIL" ? "bennett.g.vernon@vanderbilt.edu" : JSON.stringify(PASSKEY)),
  env: {},
  now: () => NOW,
};

describe("ensureSession", () => {
  it("returns a fresh cached session without calling the ceremony", async () => {
    const store = freshStore();
    await store.put({ idp: "vanderbilt", acquiredAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(), healthy: true, cookieHeader: "idx=v" });
    let ceremonyCalls = 0;
    const result = await ensureSession("vanderbilt", store, { ...DEPS, ceremony: async () => { ceremonyCalls++; return minted(); } });
    expect(result.source).toBe("cache");
    expect(ceremonyCalls).toBe(0);
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

  it("fails closed on a harvest without IdP cookies", async () => {
    const store = freshStore();
    await expect(ensureSession("vanderbilt", store, {
      ...DEPS,
      ceremony: async () => minted([{ name: "SID", value: "x", domain: ".google.com" }]),
    })).rejects.toThrow(VaultNotWiredError);
  });

  it("microsoft minting is an honest not-yet, cache still works", async () => {
    const store = freshStore();
    await expect(ensureSession("microsoft", store, DEPS)).rejects.toThrow(/build-order step 2/);
    await store.put({ idp: "microsoft", acquiredAt: NOW.toISOString(), healthy: true, cookieHeader: "MSAL=x" });
    const result = await ensureSession("microsoft", store, DEPS);
    expect(result.source).toBe("cache");
  });

  it("secret names come from the vault contract; env overrides win", async () => {
    const store = freshStore();
    const seen: string[] = [];
    await ensureSession("vanderbilt", store, {
      ceremony: async (opts) => {
        expect(opts.email).toBe("env@vanderbilt.edu");
        return minted();
      },
      secretsRead: (name) => { seen.push(name); return name === "VANDERBILT_EMAIL" ? "vault@vanderbilt.edu" : JSON.stringify(PASSKEY); },
      env: { VUTOOLKIT_VU_EMAIL: "env@vanderbilt.edu" },
      now: () => NOW,
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
});
