import { beforeEach, describe, expect, it } from "vitest";
import { brightspaceFetch, forgetBrightspace, isBrightspace } from "./brightspace.js";
import { CookieJar } from "./session-fetch.js";

const BS = "https://brightspace.vanderbilt.edu";

/**
 * A fake Brightspace (synthetic values): the API answers 403 with no session or without the
 * session's CSRF token, xsrf-tokens gives an empty token to an anonymous visitor, and /d2l/home
 * signs in through a OneVU SAML post that sets a new session cookie.
 */
function fakeBrightspace() {
  let sessions = 0;
  const live = new Set<string>();
  const sent: { url: string; method: string; csrf?: string }[] = [];
  const session = (cookie = "") => /d2lSessionVal=([^;]+)/.exec(cookie)?.[1];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const csrf = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-csrf-token")?.[1];
    const method = String(init.method ?? "GET");
    sent.push({ url, method, csrf });
    const u = new URL(url);
    const s = session(headers.cookie);
    const signedIn = s !== undefined && live.has(s);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/d2l/lp/auth/xsrf-tokens") return json(200, { hitCodePrefix: "0", referrerToken: signedIn ? `tok-${s}` : "" });
    if (u.pathname === "/d2l/home") {
      if (signedIn) return new Response("<html>" + "home ".repeat(100) + "</html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(null, { status: 302, headers: { location: "https://onevu.vanderbilt.edu/app/sso/saml" } });
    }
    if (u.hostname === "onevu.vanderbilt.edu") {
      return new Response(`<form method="post" action="${BS}/d2l/lp/auth/login/samlLogin.d2l"><input type="hidden" name="SAMLResponse" value="x"/></form>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (u.pathname === "/d2l/lp/auth/login/samlLogin.d2l") {
      const id = `S${++sessions}`;
      live.add(id);
      const h = new Headers({ location: `${BS}/d2l/home` });
      h.append("set-cookie", `d2lSessionVal=${id}; Path=/; Secure; HttpOnly`);
      return new Response(null, { status: 302, headers: h });
    }
    if (u.pathname.startsWith("/d2l/api/")) {
      if (!signedIn || csrf !== `tok-${s}`) return new Response('{ Errors: [ {Message: "Forbidden"} ] }', { status: 403, headers: { "content-type": "text/html" } });
      if (u.pathname.endsWith("/file")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00]), { status: 200, headers: { "content-type": "application/pdf" } });
      return json(200, { Identifier: "1", FirstName: "Test" });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, sent, revoke: () => live.clear() };
}

describe("brightspaceFetch", () => {
  beforeEach(() => forgetBrightspace());

  it("signs in to Brightspace, sends its CSRF token, and reuses the sign-in", async () => {
    const bs = fakeBrightspace();
    const opts = () => ({ jar: new CookieJar([{ name: "idx", value: "okta", domain: "onevu.vanderbilt.edu" }]), fetchImpl: bs.impl });
    const first = await brightspaceFetch({ url: `${BS}/d2l/api/lp/1.46/users/whoami` }, opts());
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toEqual({ Identifier: "1", FirstName: "Test" });
    expect(bs.sent.at(-1)).toMatchObject({ url: `${BS}/d2l/api/lp/1.46/users/whoami`, csrf: "tok-S1" });
    expect(first.trace).toContain("brightspace: signed in and took Brightspace's CSRF token");
    expect(first.trace.join("\n")).not.toContain("tok-");

    const count = bs.sent.length;
    const second = await brightspaceFetch({ url: `${BS}/d2l/api/le/1.75/669997/news/` }, opts());
    expect(second.status).toBe(200);
    expect(bs.sent.length - count).toBe(1);
    expect(second.trace[0]).toBe("brightspace: reused this process's Brightspace sign-in");
  });

  it("signs in again once when the kept sign-in is refused", async () => {
    const bs = fakeBrightspace();
    const opts = () => ({ jar: new CookieJar(), fetchImpl: bs.impl });
    await brightspaceFetch({ url: `${BS}/d2l/api/lp/1.46/users/whoami` }, opts());
    bs.revoke();
    const res = await brightspaceFetch({ url: `${BS}/d2l/api/lp/1.46/users/whoami` }, opts());
    expect(res.status).toBe(200);
    expect(bs.sent.at(-1)?.csrf).toBe("tok-S2");
    expect(res.trace).toContain("brightspace: 403 on the kept sign-in; signing in again");
  });

  it("keeps a caller's own X-Csrf-Token and one student's sign-in apart from another's", async () => {
    const bs = fakeBrightspace();
    await brightspaceFetch({ url: `${BS}/d2l/api/lp/1.46/users/whoami`, headers: { "X-Csrf-Token": "mine" } }, { jar: new CookieJar(), fetchImpl: bs.impl }, "/a");
    expect(bs.sent.at(-1)?.csrf).toBe("mine");
    const res = await brightspaceFetch({ url: `${BS}/d2l/api/lp/1.46/users/whoami` }, { jar: new CookieJar(), fetchImpl: bs.impl }, "/b");
    expect(res.trace[0]).not.toContain("reused");
  });

  it("returns a file's bytes when asked", async () => {
    const bs = fakeBrightspace();
    const res = await brightspaceFetch({ url: `${BS}/d2l/api/le/1.75/1/content/topics/2/file` }, { jar: new CookieJar(), fetchImpl: bs.impl, binary: true });
    expect(res.bytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00]));
  });

  it("leaves other URLs alone", async () => {
    const bs = fakeBrightspace();
    expect(isBrightspace("https://yes.vanderbilt.edu/d2l/x")).toBe(true);
    expect(isBrightspace("https://brightspace.vanderbilt.edu.evil.com/d2l/x")).toBe(false);
    expect(isBrightspace("https://more.app.vanderbilt.edu/more/")).toBe(false);
    await brightspaceFetch({ url: "https://more.app.vanderbilt.edu/nothing" }, { jar: new CookieJar(), fetchImpl: bs.impl });
    expect(bs.sent).toHaveLength(1);
  });
});
