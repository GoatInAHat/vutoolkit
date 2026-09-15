import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore, harvestToStoredSession } from "./file-store.js";
import { VaultNotWiredError } from "./index.js";

const NOW = "2026-09-15T12:00:00.000Z";

function syntheticHarvest() {
  return [
    { name: "idx", value: "synthetic-idx", domain: "onevu.vanderbilt.edu", path: "/", expires: 1800000000, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "srefresh", value: "synthetic-srefresh", domain: "onevu.vanderbilt.edu", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "JSESSIONID", value: "synthetic-jsess", domain: "onevu.vanderbilt.edu", path: "/app", secure: true, sameSite: "None" },
    // Noise from the same browser profile that must NOT be ingested:
    { name: "auth", value: "synthetic-elsewhere", domain: "twitter.com", path: "/", expires: 1800000000 },
    { name: "SID", value: "synthetic-google", domain: ".google.com", path: "/" },
    { name: "unscoped", value: "no-domain" },
  ];
}

const dirs: string[] = [];
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vutoolkit-vault-"));
  dirs.push(dir);
  return { dir, store: new FileSessionStore(join(dir, "sessions.vault.json")) };
}
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("harvestToStoredSession", () => {
  it("keeps only the IdP's domain scope and builds the header", () => {
    const s = harvestToStoredSession("vanderbilt", syntheticHarvest(), NOW);
    expect(s.cookies.map((c) => c.name)).toEqual(["idx", "srefresh", "JSESSIONID"]);
    expect(s.cookieHeader).toBe("idx=synthetic-idx; srefresh=synthetic-srefresh; JSESSIONID=synthetic-jsess");
    expect(s.expiresAt).toBe(new Date(1800000000 * 1000).toISOString());
    expect(s.healthy).toBe(true);
  });

  it("fails closed when the harvest holds no IdP cookies", () => {
    expect(() => harvestToStoredSession("microsoft", syntheticHarvest(), NOW)).toThrow(VaultNotWiredError);
  });

  it("unwraps a {cookies:[...]} envelope and parses a raw cookieHeader", () => {
    const wrapped = harvestToStoredSession("vanderbilt", { cookies: syntheticHarvest() }, NOW);
    expect(wrapped.cookies).toHaveLength(3);
    const header = harvestToStoredSession("vanderbilt", { cookieHeader: "idx=h; srefresh=i" }, NOW);
    expect(header.cookies.map((c) => c.name)).toEqual(["idx", "srefresh"]);
  });
});

describe("FileSessionStore", () => {
  it("round-trips put/get/list/forget with meta-only list output", async () => {
    const { store } = freshStore();
    expect(await store.list()).toEqual([]);
    expect(await store.get("vanderbilt")).toBeNull();
    await store.put(harvestToStoredSession("vanderbilt", syntheticHarvest(), NOW));
    const got = await store.get("vanderbilt");
    expect(got?.cookieHeader).toContain("idx=synthetic-idx");
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("cookieHeader");
    await store.forget("vanderbilt");
    expect(await store.get("vanderbilt")).toBeNull();
    await store.forget("vanderbilt"); // idempotent
  });

  it("writes the vault file 0600 and keeps other IdP rows on forget", async () => {
    const { dir, store } = freshStore();
    const path = join(dir, "nested", "sessions.vault.json");
    const s = new FileSessionStore(path);
    await s.put(harvestToStoredSession("vanderbilt", syntheticHarvest(), NOW));
    await s.put({ idp: "microsoft", acquiredAt: NOW, healthy: true, cookieHeader: "MSAL=x" });
    expect((statSync(path).mode & 0o777) === 0o600).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(raw.rows).sort()).toEqual(["microsoft", "vanderbilt"]);
    await s.forget("microsoft");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8")).rows)).toEqual(["vanderbilt"]);
  });

  it("serves cdp and storage-state payload shapes from stored cookies", async () => {
    const { store } = freshStore();
    await store.put(harvestToStoredSession("vanderbilt", syntheticHarvest(), NOW));
    const cookies = store.cookies("vanderbilt");
    const cdp = cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite }));
    expect(cdp[0]).toMatchObject({ name: "idx", domain: "onevu.vanderbilt.edu", httpOnly: true, sameSite: "Lax" });
    const storageState = { cookies: cookies.map((c) => ({ ...c, expires: c.expires ?? -1 })), origins: [] };
    expect(storageState.cookies.every((c) => typeof c.expires === "number")).toBe(true);
  });

  it("treats a corrupt vault file as vault-unavailable", async () => {
    const { dir } = freshStore();
    const path = join(dir, "sessions.vault.json");
    writeFileSync(path, "not json{");
    await expect(new FileSessionStore(path).list()).rejects.toThrow(VaultNotWiredError);
  });
});
