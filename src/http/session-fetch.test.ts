import { describe, expect, it } from "vitest";
import { CookieJar, SessionExpiredError, autoPostForm, redirectStub, sessionFetch } from "./session-fetch.js";

type Hop = { status: number; location?: string; type?: string; body?: string; setCookie?: string[] };
/** A scripted fetch: one canned response per call, recording what was sent. */
function scripted(hops: Hop[]) {
  const sent: { url: string; method: string; cookie?: string; body?: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, method: String(init.method), cookie: headers.cookie, body: init.body as string | undefined, headers });
    const hop = hops.shift();
    if (!hop) throw new Error("unexpected request");
    const h = new Headers({ "content-type": hop.type ?? "text/html" });
    if (hop.location) h.set("location", hop.location);
    for (const c of hop.setCookie ?? []) h.append("set-cookie", c);
    return new Response(hop.status >= 300 && hop.status < 400 ? null : (hop.body ?? ""), { status: hop.status, headers: h });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

describe("CookieJar", () => {
  it("scopes cookies by domain suffix and absorbs Set-Cookie", () => {
    const jar = new CookieJar([{ name: "a", value: "1", domain: ".vanderbilt.edu" }]);
    expect(jar.headerFor("https://brightspace.vanderbilt.edu/x")).toBe("a=1");
    expect(jar.headerFor("https://example.com/")).toBe("");
    jar.absorb("https://brightspace.vanderbilt.edu/", ["d2lSessionVal=2; Path=/; Secure"]);
    expect(jar.headerFor("https://brightspace.vanderbilt.edu/")).toBe("a=1; d2lSessionVal=2");
    expect(jar.headerFor("https://aai.app.vanderbilt.edu/")).toBe("a=1");
  });
});

describe("sign-in pages", () => {
  it("finds an IdP's auto-posting SAML form and decodes its fields", () => {
    const html = `<form method="post" action="https://brightspace.vanderbilt.edu/d2l/lp/auth/login/samlLogin.d2l"><input type="hidden" name="SAMLResponse" value="PHg&#x2b;"/><input type="hidden" name="RelayState" value="r"/></form>`;
    expect(autoPostForm(html, "https://onevu.vanderbilt.edu/app/sso")).toEqual({
      action: "https://brightspace.vanderbilt.edu/d2l/lp/auth/login/samlLogin.d2l",
      body: "SAMLResponse=PHg%2B&RelayState=r",
    });
    expect(autoPostForm(`<form method="post"><input type="text" name="q"></form>`, "https://x.edu/")).toBeNull();
  });

  it("follows a bare JavaScript redirect stub but not a real page", () => {
    expect(redirectStub(`<script>window.location.replace('/d2l/home')</script>`, "https://brightspace.vanderbilt.edu/")).toBe("https://brightspace.vanderbilt.edu/d2l/home");
    expect(redirectStub(`<p>${"words ".repeat(60)}</p><script>window.location='/x'</script>`, "https://a.edu/")).toBeNull();
  });
});

describe("sessionFetch", () => {
  it("rides a SAML dance to the service and returns its response without Set-Cookie", async () => {
    const { impl, sent } = scripted([
      { status: 302, location: "https://onevu.vanderbilt.edu/app/sso/saml" },
      { status: 200, body: `<form method="POST" action="https://brightspace.vanderbilt.edu/acs"><input type="hidden" name="SAMLResponse" value="x"></form>`, setCookie: ["idx=1; Domain=vanderbilt.edu"] },
      { status: 302, location: "https://brightspace.vanderbilt.edu/d2l/api/lp/1.46/users/whoami", setCookie: ["d2l=2"] },
      { status: 200, type: "application/json", body: `{"FirstName":"S"}`, setCookie: ["d2l=3"] },
    ]);
    const jar = new CookieJar([{ name: "okta", value: "s", domain: "onevu.vanderbilt.edu" }]);
    const res = await sessionFetch({ url: "https://brightspace.vanderbilt.edu/d2l/api/lp/1.46/users/whoami", headers: { cookie: "evil=1", accept: "application/json" } }, { jar, fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(res.text).toBe(`{"FirstName":"S"}`);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(sent[0].cookie).toBeUndefined();
    expect(sent[0].headers.accept).toBe("application/json");
    expect(sent[1].cookie).toBe("okta=s");
    expect(sent[2]).toMatchObject({ method: "POST", body: "SAMLResponse=x" });
    expect(sent[3].cookie).toBe("idx=1; d2l=2");
    expect(res.trace).toEqual(["302 brightspace.vanderbilt.edu/d2l/api/lp/1.46/users/whoami", "200 onevu.vanderbilt.edu/app/sso/saml", "POST 302 brightspace.vanderbilt.edu/acs", "200 brightspace.vanderbilt.edu/d2l/api/lp/1.46/users/whoami"]);
  });

  it("sends a POST once more after it had to sign in", async () => {
    const { impl, sent } = scripted([
      { status: 302, location: "https://onevu.vanderbilt.edu/sso" },
      { status: 302, location: "https://app.vanderbilt.edu/done" },
      { status: 200, body: "landing" },
      { status: 201, type: "application/json", body: "{}" },
    ]);
    const res = await sessionFetch({ url: "https://app.vanderbilt.edu/api", method: "POST", body: "{}", headers: { "content-type": "application/json" } }, { jar: new CookieJar(), fetchImpl: impl });
    expect(res.status).toBe(201);
    expect(sent[3]).toMatchObject({ url: "https://app.vanderbilt.edu/api", method: "POST", body: "{}" });
  });

  it("does not resend a POST that the service redirected elsewhere without a sign-in", async () => {
    const { impl, sent } = scripted([
      { status: 303, location: "https://other.vanderbilt.edu/confirmation" },
      { status: 200, body: "<html><body>" + "Saved. ".repeat(50) + "</body></html>" },
    ]);
    const res = await sessionFetch({ url: "https://app.vanderbilt.edu/api", method: "POST", body: "x=1" }, { jar: new CookieJar(), fetchImpl: impl });
    expect(sent.map((s) => s.method)).toEqual(["POST", "GET"]);
    expect(res.url).toBe("https://other.vanderbilt.edu/confirmation");
  });

  it("runs the guard on every hop and stops at a refused one", async () => {
    const { impl, sent } = scripted([{ status: 302, location: "https://more.app.vanderbilt.edu/more/StudentClassExecute!add.action" }]);
    const guard = (url: string) => {
      if (url.includes("StudentClassExecute")) throw new Error("refused");
    };
    await expect(sessionFetch({ url: "https://app.vanderbilt.edu/x" }, { jar: new CookieJar(), fetchImpl: impl, guard })).rejects.toThrow("refused");
    expect(sent).toHaveLength(1);
  });

  it("reports a refused session when the dance ends on the sign-in page", async () => {
    const { impl } = scripted([
      { status: 302, location: "https://login.microsoftonline.com/common/oauth2/authorize" },
      { status: 200, body: "<html><body>" + "Sign in ".repeat(50) + "</body></html>" },
    ]);
    const error = await sessionFetch({ url: "https://outlook.office.com/owa/" }, { jar: new CookieJar(), fetchImpl: impl }).catch((e) => e);
    expect(error).toBeInstanceOf(SessionExpiredError);
    expect(error.idp).toBe("microsoft");
  });
});
