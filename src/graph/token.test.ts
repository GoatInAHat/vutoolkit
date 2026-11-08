import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError } from "../sso/errors.js";
import type { CookieRecord } from "../vault/file-store.js";
import { VaultNotWiredError } from "../vault/index.js";
import { classifyAuthorize, ensureGraphToken, GraphTokenCache, MAX_ENVELOPE_BYTES } from "./token.js";
import type { CredentialStorage } from "../vault/credential-store.js";
import { graphCall } from "./client.js";

const REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/token";
const entsCookies: CookieRecord[] = [
  { name: "ESTSAUTHPERSISTENT", value: "ent-1", domain: "login.microsoftonline.com" },
  { name: "SuiteServiceProxyKey", value: "owa-1", domain: "outlook.cloud.microsoft" },
];

interface Captured {
  url: string;
  cookie?: string;
  body?: string;
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

const newCache = (): GraphTokenCache => {
  dir = mkdtempSync(join(tmpdir(), "vutoolkit-graph-"));
  return new GraphTokenCache(join(dir, "graph-token.json"));
};

const okToken = (accessToken = "AT", expires_in = 3600): Response =>
  new Response(JSON.stringify({ access_token: accessToken, expires_in }), { status: 200 });

describe("classifyAuthorize", () => {
  it("reads the code from the redirect query", () => {
    expect(classifyAuthorize(302, REDIRECT, REDIRECT + "?code=XYZ", "")).toEqual({ kind: "code", code: "XYZ" });
  });
  it("reads a refusal from the redirect query", () => {
    expect(classifyAuthorize(302, REDIRECT, REDIRECT + "?error=interaction_required", "")).toEqual({
      kind: "refused",
      error: "interaction_required",
    });
  });
  it("reads the code from a form_post body", () => {
    expect(classifyAuthorize(200, "https://login.microsoftonline.com/x", null, '<input name="code" value="ABC">')).toEqual({
      kind: "code",
      code: "ABC",
    });
  });
  it("treats a sign-in page as a refusal", () => {
    expect(classifyAuthorize(200, "https://login.microsoftonline.com/x", null, 'name="loginfmt"')).toEqual({
      kind: "refused",
      error: "login page",
    });
  });
  it("leaves anything else unexpected", () => {
    expect(classifyAuthorize(500, "https://login.microsoftonline.com/x", null, "boom")).toEqual({
      kind: "unexpected",
      status: 500,
      finalUrl: "https://login.microsoftonline.com/x",
    });
  });
});

describe("ensureGraphToken", () => {
  it("serves a live cached token without any network", async () => {
    const cache = newCache();
    await cache.put({ accessToken: "CACHED", acquiredAtMs: Date.now(), expiresAtMs: Date.now() + 600_000 });
    const token = await ensureGraphToken(entsCookies, cache, {
      fetchImpl: (() => Promise.reject(new Error("network must not be touched"))) as unknown as typeof fetch,
    });
    expect(token).toMatchObject({ accessToken: "CACHED", source: "cache" });
  });

  it("mints through the silent 302 and caches the token 0600", async () => {
    const cache = newCache();
    const calls: Captured[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://login.microsoftonline.com/common/oauth2/authorize")) {
        calls.push({ url: target, cookie: (init?.headers as Record<string, string>).cookie });
        return new Response(null, { status: 302, headers: { location: REDIRECT + "?code=XYZ" } });
      }
      calls.push({ url: target, body: String(init?.body) });
      return okToken();
    }) as unknown as typeof fetch;
    const token = await ensureGraphToken(entsCookies, cache, { fetchImpl });
    expect(token).toMatchObject({ accessToken: "AT", source: "minted" });
    expect(calls[1]?.url).toBe(TOKEN_URL);
    expect(calls[1]?.body).toContain("code=XYZ");
    expect(calls[1]?.body).not.toContain("secret");
    const cached = cache.read();
    expect(cached?.accessToken).toBe("AT");
    expect(statSync(cache.location).mode & 0o777).toBe(0o600);
  });

  it("scopes the authorize cookie header to the login host", async () => {
    const cache = newCache();
    let cookieHeader = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/authorize")) {
        cookieHeader = (init?.headers as Record<string, string>).cookie;
        return new Response(null, { status: 302, headers: { location: REDIRECT + "?code=XYZ" } });
      }
      return okToken();
    }) as unknown as typeof fetch;
    await ensureGraphToken(entsCookies, cache, { fetchImpl });
    expect(cookieHeader).toContain("ESTSAUTHPERSISTENT=ent-1");
    expect(cookieHeader).not.toContain("SuiteServiceProxyKey");
  });

  it("refusals become a retryable GRAPH_TOKEN_UNAVAILABLE", async () => {
    const cache = newCache();
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: REDIRECT + "?error=interaction_required" } })) as unknown as typeof fetch;
    const error = await ensureGraphToken(entsCookies, cache, { fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe("GRAPH_TOKEN_UNAVAILABLE");
    expect((error as AuthError).retryable).toBe(true);
    expect((error as Error).message).toContain("sessions.refresh");
  });

  it("exchange failures name the server's error, never a token", async () => {
    const cache = newCache();
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("/authorize")
        ? new Response(null, { status: 302, headers: { location: REDIRECT + "?code=XYZ" } })
        : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    const error = (await ensureGraphToken(entsCookies, cache, { fetchImpl }).catch((e: unknown) => e)) as AuthError;
    expect(error.code).toBe("GRAPH_TOKEN_UNAVAILABLE");
    expect(error.message).toContain("invalid_grant");
  });

  it("shares one mint across concurrent callers", async () => {
    const cache = newCache();
    let authorizes = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.includes("/authorize")) {
        authorizes++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(null, { status: 302, headers: { location: REDIRECT + "?code=XYZ" } });
      }
      return okToken();
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      ensureGraphToken(entsCookies, cache, { fetchImpl }),
      ensureGraphToken(entsCookies, cache, { fetchImpl }),
    ]);
    expect(authorizes).toBe(1);
    expect(a.accessToken).toBe("AT");
    expect(b.accessToken).toBe("AT");
  });

  it("force re-mints even with a live cache", async () => {
    const cache = newCache();
    await cache.put({ accessToken: "CACHED", acquiredAtMs: Date.now(), expiresAtMs: Date.now() + 600_000 });
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("/authorize")
        ? new Response(null, { status: 302, headers: { location: REDIRECT + "?code=XYZ" } })
        : okToken("FRESH")) as unknown as typeof fetch;
    const token = await ensureGraphToken(entsCookies, cache, { fetchImpl, force: true });
    expect(token).toMatchObject({ accessToken: "FRESH", source: "minted" });
  });
});

describe("ensureGraphToken failure modes", () => {
  /** A silent authorize that lands on the sign-in page instead of the redirect URI: a refusal. */
  const signInPageFetch = (onAuthorize?: () => void) =>
    (async (url: string | URL | Request) => {
      if (String(url).includes("/authorize")) {
        onAuthorize?.();
        return new Response('<form><input name="loginfmt" id="i0116"><input name="urlPost"></form>', { status: 200 });
      }
      throw new Error("a refused authorize must not reach the token exchange");
    }) as unknown as typeof fetch;

  it("a sign-in page refusal is a retryable GRAPH_TOKEN_UNAVAILABLE that caches nothing", async () => {
    const cache = newCache();
    const error = (await ensureGraphToken(entsCookies, cache, { fetchImpl: signInPageFetch() }).catch(
      (e: unknown) => e,
    )) as AuthError;
    expect(error).toBeInstanceOf(AuthError);
    expect(error.code).toBe("GRAPH_TOKEN_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    // The message names the remedy and carries no session or token material.
    expect(error.message).toContain("sessions.refresh");
    for (const secret of [...entsCookies.map((c) => c.value), "ent-1", "owa-1"]) expect(error.message).not.toContain(secret);
    expect(cache.read()).toBeNull();
  });

  it("a refusal leaves a previously cached token untouched instead of inventing a fresh one", async () => {
    const cache = newCache();
    const stale = { accessToken: "STALE", acquiredAtMs: 1, expiresAtMs: 2 };
    await cache.put(stale);
    await expect(ensureGraphToken(entsCookies, cache, { fetchImpl: signInPageFetch() })).rejects.toMatchObject({
      code: "GRAPH_TOKEN_UNAVAILABLE",
    });
    expect(cache.read()).toEqual(stale);
  });

  it("graph.call's token provider bubbles the typed refusal and makes no Graph request", async () => {
    const cache = newCache();
    let authorizes = 0;
    const graphFetches: string[] = [];
    // Same shape as src/ops.ts graph.call: ensureGraphToken(...).then(t => t.accessToken).
    const getToken = (opts: { force?: boolean }) =>
      ensureGraphToken(entsCookies, cache, { ...opts, fetchImpl: signInPageFetch(() => authorizes++) }).then(
        (token) => token.accessToken,
      );
    const fetchImpl = (async (url: string | URL | Request) => {
      graphFetches.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      graphCall("GET", "/me", undefined, undefined, getToken, { fetchImpl, sleep: async () => {} }),
    ).rejects.toMatchObject({ code: "GRAPH_TOKEN_UNAVAILABLE", retryable: true });
    expect(authorizes).toBe(1);
    expect(graphFetches).toHaveLength(0);
    expect(cache.read()).toBeNull();
  });
});

describe("GraphTokenCache bounds", () => {
  /** Largest accessToken whose single-line JSON envelope is exactly `bytes` long. */
  const tokenSizedTo = (bytes: number): { accessToken: string; acquiredAtMs: number; expiresAtMs: number } => {
    const fixed = { acquiredAtMs: 1_700_000_000_000, expiresAtMs: 1_700_003_600_000 };
    const skeletonLength = Buffer.byteLength(JSON.stringify({ accessToken: "", ...fixed }), "utf8");
    return { accessToken: "A".repeat(bytes - skeletonLength), ...fixed };
  };

  it("refuses an oversized envelope in file mode and leaves no readable entry", async () => {
    const cache = newCache();
    const token = tokenSizedTo(MAX_ENVELOPE_BYTES + 1);
    expect(Buffer.byteLength(JSON.stringify(token), "utf8")).toBe(MAX_ENVELOPE_BYTES + 1);
    let error: unknown;
    try { await cache.put(token); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(VaultNotWiredError);
    expect((error as Error).message).toContain(String(MAX_ENVELOPE_BYTES));
    expect((error as Error).message).toContain("no credential was written");
    expect(cache.read()).toBeNull();
  });

  it("never calls the credential storage write for an oversized envelope", async () => {
    const writes: string[] = [];
    const storage: CredentialStorage = {
      location: "fake:vault",
      read: () => null,
      write: async (value) => { writes.push(value); },
    };
    const cache = new GraphTokenCache(join(tmpdir(), "unused-graph-token.json"), storage);
    const token = tokenSizedTo(MAX_ENVELOPE_BYTES + 1);
    await expect(cache.put(token)).rejects.toThrow(VaultNotWiredError);
    expect(writes).toHaveLength(0);
    expect(cache.read()).toBeNull();
  });

  it("writes and reads back an envelope at exactly the boundary", async () => {
    const cache = newCache();
    const token = tokenSizedTo(MAX_ENVELOPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(token), "utf8")).toBe(MAX_ENVELOPE_BYTES);
    await cache.put(token);
    expect(cache.read()).toEqual(token);
  });
});
