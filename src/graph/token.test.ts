import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError } from "../sso/errors.js";
import type { CookieRecord } from "../vault/file-store.js";
import { classifyAuthorize, ensureGraphToken, GraphTokenCache } from "./token.js";

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
    cache.put({ accessToken: "CACHED", acquiredAtMs: Date.now(), expiresAtMs: Date.now() + 600_000 });
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
    cache.put({ accessToken: "CACHED", acquiredAtMs: Date.now(), expiresAtMs: Date.now() + 600_000 });
    const fetchImpl = (async (url: string | URL | Request) =>
      String(url).includes("/authorize")
        ? new Response(null, { status: 302, headers: { location: REDIRECT + "?code=XYZ" } })
        : okToken("FRESH")) as unknown as typeof fetch;
    const token = await ensureGraphToken(entsCookies, cache, { fetchImpl, force: true });
    expect(token).toMatchObject({ accessToken: "FRESH", source: "minted" });
  });
});
