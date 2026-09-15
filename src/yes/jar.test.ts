import { describe, expect, it } from "vitest";
import { CookieJar, jarFetch } from "./jar.js";
import type { CookieRecord } from "../vault/file-store.js";

function cookie(name: string, value: string, domain: string): CookieRecord {
  return { name, value, domain, path: "/", secure: true };
}

/** Minimal scripted fetch: maps URL -> status/location/body, records seen cookie headers. */
function scriptedFetch(routes: Record<string, { status?: number; location?: string; body?: string; setCookie?: string[] }>, seen: string[] = []) {
  return (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    seen.push(`${href}|${new Headers(init?.headers).get("cookie") ?? ""}`);
    const route = routes[href] ?? { status: 404, body: "no route" };
    const headers = new Headers();
    if (route.location) headers.set("location", route.location);
    if (route.setCookie) for (const c of route.setCookie) headers.append("set-cookie", c);
    headers.set("content-type", "text/html");
    return new Response(route.body ?? "", { status: route.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

describe("CookieJar", () => {
  it("scopes cookies by domain suffix", () => {
    const jar = new CookieJar([cookie("idx", "v", "onevu.vanderbilt.edu"), cookie("JSESSIONID", "s", "aai.app.vanderbilt.edu")]);
    expect(jar.headerFor("https://aai.app.vanderbilt.edu/aai")).toBe("JSESSIONID=s");
    expect(jar.headerFor("https://onevu.vanderbilt.edu/app/UserHome")).toBe("idx=v");
    expect(jar.headerFor("https://github.com/")).toBe("");
  });

  it("matches parent-domain cookies against subdomains", () => {
    const jar = new CookieJar([cookie("AWSALB", "a", ".aai.app.vanderbilt.edu")]);
    expect(jar.headerFor("https://aai.app.vanderbilt.edu/aai")).toBe("AWSALB=a");
  });

  it("absorbs set-cookie with a Domain attribute and overwrites same name+domain", () => {
    const jar = new CookieJar([cookie("JSESSIONID", "old", "aai.app.vanderbilt.edu")]);
    jar.absorb("https://aai.app.vanderbilt.edu/aai", ["JSESSIONID=new; Path=/; Secure; HttpOnly", "fresh=f1; Domain=.vanderbilt.edu; Path=/"]);
    expect(jar.headerFor("https://aai.app.vanderbilt.edu/aai")).toContain("JSESSIONID=new");
    expect(jar.headerFor("https://yes.vanderbilt.edu/")).toContain("fresh=f1");
  });
});

describe("jarFetch", () => {
  it("walks a redirect dance, absorbing cookies at every hop", async () => {
    const seen: string[] = [];
    const impl = scriptedFetch(
      {
        "https://aai.app.vanderbilt.edu/aai": { status: 302, location: "https://onevu.vanderbilt.edu/authorize", setCookie: ["SPID=sp1; Path=/"] },
        // host-only cookie (no Domain attr): must stay on onevu, never ride to aai.
        "https://onevu.vanderbilt.edu/authorize": { status: 302, location: "https://aai.app.vanderbilt.edu/callback", setCookie: ["idx=ok; Path=/"] },
        "https://aai.app.vanderbilt.edu/callback": { status: 200, body: "<table><tr><th>done</th></tr></table>" },
      },
      seen,
    );
    const jar = new CookieJar([cookie("seed", "1", "vanderbilt.edu")]);
    const res = await jarFetch("https://aai.app.vanderbilt.edu/aai", { jar, fetchImpl: impl });
    expect(res.status).toBe(200);
    expect(res.trace).toHaveLength(3);
    // parent-domain seed rode every hop; the SP cookie minted at hop 0 was NOT sent to onevu.
    expect(seen[0]).toContain("seed=1");
    expect(seen[1]).toContain("seed=1");
    expect(seen[1]).not.toContain("SPID=sp1");
    // the callback hop sees the seed and the SP cookie, but never onevu's host-only idx.
    expect(seen[2]).toContain("seed=1");
    expect(seen[2]).toContain("SPID=sp1");
    expect(seen[2]).not.toContain("idx=ok");
  });

  it("fails loudly past maxHops instead of spinning", async () => {
    const impl = scriptedFetch({
      "https://aai.app.vanderbilt.edu/loop": { status: 302, location: "https://aai.app.vanderbilt.edu/loop" },
    });
    await expect(
      jarFetch("https://aai.app.vanderbilt.edu/loop", { jar: new CookieJar(), fetchImpl: impl, maxHops: 3 }),
    ).rejects.toThrow(/exceeded 3 redirects/);
  });
});
