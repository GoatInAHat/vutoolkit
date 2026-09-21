import { describe, expect, it } from "vitest";
import { graphCall, graphUrl, type TokenProvider } from "./client.js";

const bearer = (init?: RequestInit): string => String((init?.headers as Record<string, string>)?.authorization ?? "");
const provider = (log: string[]): TokenProvider => async (opts) => {
  log.push(opts?.force ? "force" : "normal");
  return opts?.force ? "AT2" : "AT1";
};

describe("graphUrl", () => {
  it("pins the v1.0 origin and encodes query", () => {
    expect(graphUrl("/me/messages", { $top: 3 })).toBe("https://graph.microsoft.com/v1.0/me/messages?%24top=3");
  });
  it("rejects paths that would leave the origin", () => {
    expect(() => graphUrl("https://evil.example/x")).toThrow(TypeError);
    expect(() => graphUrl("//evil.example/x")).toThrow(TypeError);
    expect(() => graphUrl("me")).toThrow(TypeError);
  });
});

describe("graphCall", () => {
  it("returns parsed JSON with the token attached", async () => {
    let seen = "";
    const res = await graphCall(
      "GET",
      "/me",
      undefined,
      undefined,
      async () => "AT1",
      {
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          seen = bearer(init);
          return new Response(JSON.stringify({ displayName: "Vernon, Bennett G" }), { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(res).toEqual({ status: 200, data: { displayName: "Vernon, Bennett G" } });
    expect(seen).toBe("Bearer AT1");
  });

  it("serializes the body and sets the content type", async () => {
    let body: string | undefined;
    let contentType = "";
    const res = await graphCall("POST", "/me/sendMail", undefined, { message: {} }, async () => "AT1", {
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        body = init?.body as string;
        contentType = String((init?.headers as Record<string, string>)["content-type"] ?? "");
        return new Response("", { status: 202 });
      }) as unknown as typeof fetch,
    });
    expect(res.status).toBe(202);
    expect(body).toBe(JSON.stringify({ message: {} }));
    expect(contentType).toBe("application/json");
  });

  it("re-mints once on 401", async () => {
    const calls: string[] = [];
    let first = true;
    const res = await graphCall("GET", "/me", undefined, undefined, provider(calls), {
      fetchImpl: (async () => {
        calls.push("fetch");
        if (first) {
          first = false;
          return new Response("expired", { status: 401 });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["normal", "fetch", "force", "fetch"]);
  });

  it("honors Retry-After on 429 and then succeeds", async () => {
    const sleeps: number[] = [];
    let throttled = false;
    const res = await graphCall("GET", "/me", undefined, undefined, async () => "AT1", {
      fetchImpl: (async () => {
        if (!throttled) {
          throttled = true;
          return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(sleeps).toEqual([0]);
  });

  it("caps the throttle wait and surfaces a persistent 429", async () => {
    const sleeps: number[] = [];
    const res = await graphCall("GET", "/me", undefined, undefined, async () => "AT1", {
      fetchImpl: (async () => new Response("slow down", { status: 429, headers: { "retry-after": "3600" } })) as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(429);
    expect(sleeps).toEqual([30_000, 30_000]);
  });
});
