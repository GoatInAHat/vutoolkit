import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureGraphToken, graphTokenCache } from "../graph/token.js";
import { sessionStore, harvestToStoredSession } from "./file-store.js";
import { operations } from "../ops.js";
import { credentialSecretName, credentialStorage, migrateCredentialCaches, NativeCredentialStorage, nativeSecrets, type NativeSecrets } from "./credential-store.js";

const dirs: string[] = [];
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "vutoolkit-native-vault-")); dirs.push(dir); return dir; };
const token = { accessToken: "synthetic-token", acquiredAtMs: 10, expiresAtMs: 1_000_000 };
const session = harvestToStoredSession("microsoft", [{ name: "ESTS", value: "synthetic-cookie", domain: "login.microsoftonline.com" }], "2026-10-09T00:00:00Z");
function fixture() {
  const values = new Map<string, string>();
  const secrets: NativeSecrets = { read: (name) => values.get(name) ?? null, write: (name, value) => { values.set(name, value); } };
  return { values, secrets };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("native credential storage", () => {
  it("routes both configured operation factories to the host vault without creating plaintext files", async () => {
    const dir = fresh(); const { values, secrets } = fixture();
    vi.stubEnv("VUTOOLKIT_CREDENTIAL_STORE", "openclaw");
    vi.spyOn(nativeSecrets, "read").mockImplementation(secrets.read);
    vi.spyOn(nativeSecrets, "write").mockImplementation(secrets.write);
    const sessions = sessionStore(dir);
    await sessions.put(session);
    expect((await sessionStore(dir).get("microsoft"))?.cookieHeader).toBe(session.cookieHeader);
    expect(sessionStore(dir).cookies("microsoft")).toEqual(session.cookies);
    expect(await sessionStore(dir).list()).toEqual([{ idp: "microsoft", acquiredAt: session.acquiredAt, healthy: true }]);
    const graph = graphTokenCache(dir);
    graph.put(token);
    const result = await ensureGraphToken([], graphTokenCache(dir), { now: () => 100, fetchImpl: vi.fn() });
    expect(result.source).toBe("cache");
    expect(existsSync(join(dir, "sessions.vault.json"))).toBe(false);
    expect(existsSync(join(dir, "graph-token.json"))).toBe(false);
    expect(values.size).toBe(2);
    await sessions.forget("microsoft");
    expect(await sessionStore(dir).get("microsoft")).toBeNull();
  });

  it("keeps standalone file storage as the portable default and scopes names by data directory", async () => {
    const dir = fresh();
    const store = sessionStore(dir, { VUTOOLKIT_CREDENTIAL_STORE: "file" });
    await store.put(session);
    expect(existsSync(join(dir, "sessions.vault.json"))).toBe(true);
    expect(credentialSecretName(dir, "sessions_microsoft")).not.toBe(credentialSecretName(fresh(), "sessions_microsoft"));
    expect(() => credentialStorage(dir, "graph", { VUTOOLKIT_CREDENTIAL_STORE: "typo" })).toThrow(/must be/);
    expect(sessionStore(dir, {}).location).toBe(join(dir, "sessions.vault.json"));
  });

  it("uses native Context config and does not overwrite another IdP during a concurrent update", async () => {
    const dir = fresh(); const { values, secrets } = fixture();
    const vu = { idp: "vanderbilt", acquiredAt: session.acquiredAt, healthy: true, cookieHeader: "synthetic-vu-new", cookies: [] };
    vi.spyOn(nativeSecrets, "read").mockImplementation(secrets.read);
    vi.spyOn(nativeSecrets, "write").mockImplementation((name, value) => {
      values.set(credentialSecretName(dir, "sessions_vanderbilt"), JSON.stringify(vu));
      secrets.write(name, value);
    });
    const env = { VUTOOLKIT_CREDENTIAL_STORE: "openclaw" };
    await sessionStore(dir, env).put(session);
    const operation = operations.find((op) => op.name === "sessions.list")!;
    const listed = await operation.handler({} as never, { dataDir: dir, config: env });
    expect(JSON.stringify(listed)).toContain('"vanderbilt"');
    expect(JSON.stringify(listed)).not.toContain("synthetic-vu-new");
    await sessionStore(dir, env).forget("microsoft");
    expect((await sessionStore(dir, env).get("vanderbilt"))?.cookieHeader).toBe("synthetic-vu-new");
    expect(await sessionStore(dir, env).get("microsoft")).toBeNull();
  });

  it("migrates both caches with exact readback while preserving originals and returning metadata only", () => {
    const dir = fresh(); const { values, secrets } = fixture();
    const sessionsRaw = JSON.stringify({ version: 1, rows: { microsoft: session } });
    writeFileSync(join(dir, "sessions.vault.json"), sessionsRaw);
    writeFileSync(join(dir, "graph-token.json"), JSON.stringify(token));
    const guarded = credentialStorage(dir, "graph", { VUTOOLKIT_CREDENTIAL_STORE: "openclaw" }, secrets)!;
    expect(() => guarded.read()).toThrow(/migration/);
    expect(() => guarded.write(JSON.stringify(token))).toThrow(/migration/);
    const result = migrateCredentialCaches(dir, secrets);
    expect(result.migrated).toHaveLength(3);
    expect(result.originalsPreserved).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-token|synthetic-cookie/);
    expect(values.get(credentialSecretName(dir, "sessions_microsoft"))).toBe(JSON.stringify(session));
    expect(guarded.read()).toBe(JSON.stringify(token));
    expect(readFileSync(join(dir, "sessions.vault.json"), "utf8")).toBe(sessionsRaw);
    expect(migrateCredentialCaches(dir, secrets)).toEqual(result);
  });

  it("preserves originals on failed readback and rejects conflicting existing native values", () => {
    const dir = fresh(); const { values, secrets } = fixture();
    const path = join(dir, "graph-token.json"); const raw = JSON.stringify(token);
    writeFileSync(path, raw);
    const broken: NativeSecrets = { read: () => null, write: () => {} };
    expect(() => migrateCredentialCaches(dir, broken)).toThrow(/readback/);
    expect(readFileSync(path, "utf8")).toBe(raw);
    values.set(credentialSecretName(dir, "graph"), "different-synthetic-value");
    expect(() => migrateCredentialCaches(dir, secrets)).toThrow(/differs/);
    expect(values.get(credentialSecretName(dir, "graph"))).toBe("different-synthetic-value");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("detects old-writer activity during migration and never deletes the original", () => {
    const dir = fresh(); const { secrets } = fixture(); const path = join(dir, "graph-token.json");
    writeFileSync(path, JSON.stringify(token));
    const updated = JSON.stringify({ ...token, accessToken: "synthetic-newer-token" });
    const concurrent: NativeSecrets = { ...secrets, write(name, value) { secrets.write(name, value); writeFileSync(path, updated); } };
    expect(() => migrateCredentialCaches(dir, concurrent)).toThrow(/changed during migration/);
    expect(readFileSync(path, "utf8")).toBe(updated);
  });

  it("fails closed on vault outages, malformed envelopes and oversized values", async () => {
    const dir = fresh(); const { values, secrets } = fixture();
    vi.spyOn(nativeSecrets, "read").mockImplementation(secrets.read);
    vi.spyOn(nativeSecrets, "write").mockImplementation(secrets.write);
    values.set(credentialSecretName(dir, "sessions_microsoft"), "invalid-json");
    await expect(sessionStore(dir, { VUTOOLKIT_CREDENTIAL_STORE: "openclaw" }).put(session)).rejects.toThrow(/invalid/);
    values.set(credentialSecretName(dir, "graph"), "{}");
    expect(() => graphTokenCache(dir, { VUTOOLKIT_CREDENTIAL_STORE: "openclaw" }).read()).toThrow(/invalid/);
    expect(() => new NativeCredentialStorage("TEST", secrets).write("x".repeat(65_537))).toThrow(/64 KiB/);
    vi.mocked(nativeSecrets.read).mockImplementation(() => { throw new Error("synthetic vault unavailable"); });
    expect(() => graphTokenCache(dir, { VUTOOLKIT_CREDENTIAL_STORE: "openclaw" }).read()).toThrow(/vault unavailable/);
    expect(existsSync(join(dir, "graph-token.json"))).toBe(false);
  });
});
