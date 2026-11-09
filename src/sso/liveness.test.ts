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

/** Answers /me with the given statuses in order, then 200; records how many proof GETs ran. */
function throttledGraphFetch(statuses: number[], retryAfter?: string): { fetch: typeof fetch; calls: () => number } {
  const meCalls: string[] = [];
  const inner = graphFetch();
  let throttles = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "https://graph.microsoft.com/v1.0/me?$select=id") {
      meCalls.push("proof");
      if (throttles < statuses.length) {
        const status = statuses[throttles++];
        const headers = new Headers();
        if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
        return new Response("{}", { status, headers });
      }
    }
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls: () => meCalls.length };
}

describe("probeMicrosoft", () => {
  it("proves liveness through the silent Graph token flow and read-only /me", async () => {
    expect(await probeMicrosoft(cookies, graphFetch())).toBe(true);
  });

  it("rejects a Graph session whose proof request is unauthorized", async () => {
    expect(await probeMicrosoft(cookies, graphFetch(401))).toBe(false);
  });

  it("treats a throttled proof GET as alive after honoring retry-after bounded retries", async () => {
    const { fetch, calls } = throttledGraphFetch([429, 429], "0");
    const waits: number[] = [];
    expect(await probeMicrosoft(cookies, fetch, async (ms) => { waits.push(ms); })).toBe(true);
    // Two throttled answers then the 200: one token mint, three proof GETs, both waits honored.
    expect(calls()).toBe(3);
    expect(waits).toEqual([0, 0]);
  });

  it("caps a missing or oversized retry-after instead of trusting it", async () => {
    const { fetch } = throttledGraphFetch([429], undefined);
    const waits: number[] = [];
    expect(await probeMicrosoft(cookies, fetch, async (ms) => { waits.push(ms); })).toBe(true);
    // No retry-after header: wait the cap (30s), never a negative or unbounded delay.
    expect(waits).toEqual([30_000]);

    const big = throttledGraphFetch([429], "9999");
    const capped: number[] = [];
    expect(await probeMicrosoft(cookies, big.fetch, async (ms) => { capped.push(ms); })).toBe(true);
    expect(capped).toEqual([30_000]);
  });

  it("gives up and reports not-alive when throttling outlasts the bounded retries", async () => {
    const { fetch, calls } = throttledGraphFetch([429, 429, 429], "0");
    const waits: number[] = [];
    expect(await probeMicrosoft(cookies, fetch, async (ms) => { waits.push(ms); })).toBe(false);
    // One attempt plus two retries, then a truthful false rather than an unbounded wait.
    expect(calls()).toBe(3);
    // The cap is exactly 2 retries: no third sleep, no fourth proof GET.
    expect(waits).toEqual([0, 0]);
  });

  it("stays bounded when every possible throttle answer is delivered", async () => {
    // Ten 429s offered, only the cap's worth of retries are spent: 3 proof GETs, 2 waits.
    const { fetch, calls } = throttledGraphFetch(Array.from({ length: 10 }, () => 429), "0");
    const waits: number[] = [];
    expect(await probeMicrosoft(cookies, fetch, async (ms) => { waits.push(ms); })).toBe(false);
    expect(calls()).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("rejects an empty cookie set without network access", async () => {
    const fetchImpl = (() => { throw new Error("must not call network"); }) as typeof fetch;
    expect(await probeMicrosoft([], fetchImpl)).toBe(false);
  });
});
