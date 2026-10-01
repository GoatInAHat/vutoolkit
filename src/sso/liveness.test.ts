import { describe, expect, it } from "vitest";
import type { CookieRecord } from "../vault/file-store.js";
import { probeMicrosoft } from "./liveness.js";

const cookies: CookieRecord[] = [
  { name: "ESTSAUTHPERSISTENT", value: "redacted-fixture", domain: "login.microsoftonline.com" },
];

function graphFetch(meStatus = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/common/oauth2/authorize")) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://login.microsoftonline.com/common/oauth2/nativeclient?code=fixture" },
      });
    }
    if (url === "https://login.microsoftonline.com/common/oauth2/token") {
      return new Response(JSON.stringify({ access_token: "in-memory-fixture", expires_in: 3600 }), { status: 200 });
    }
    if (url === "https://graph.microsoft.com/v1.0/me?$select=id") {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer in-memory-fixture");
      return new Response("{}", { status: meStatus });
    }
    throw new Error("unexpected request " + url);
  }) as typeof fetch;
}

describe("probeMicrosoft", () => {
  it("proves liveness through the silent Graph token flow and read-only /me", async () => {
    expect(await probeMicrosoft(cookies, graphFetch())).toBe(true);
  });

  it("rejects a Graph session whose proof request is unauthorized", async () => {
    expect(await probeMicrosoft(cookies, graphFetch(401))).toBe(false);
  });

  it("rejects an empty cookie set without network access", async () => {
    const fetchImpl = (() => { throw new Error("must not call network"); }) as typeof fetch;
    expect(await probeMicrosoft([], fetchImpl)).toBe(false);
  });
});
