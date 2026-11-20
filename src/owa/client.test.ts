import { describe, expect, it, vi } from "vitest";
import { envelope, expectSuccess, sideEffect, jwtExpiry, owaCall, OwaError, stripTypes, type OwaToken } from "./client.js";

const token = (n: number): OwaToken => ({ token: `t${n}`, origin: "https://outlook.cloud.microsoft", anchorMailbox: "PUID:1@tenant", expiresAt: Date.now() + 3_600_000 });
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("envelope", () => {
  it("wraps a body in OWA's request envelope", () => {
    const e = envelope("FindItem", { Traversal: "Shallow" }) as any;
    expect(e.__type).toBe("FindItemJsonRequest:#Exchange");
    expect(e.Header.RequestServerVersion).toBe("V2018_01_08");
    expect(e.Header.TimeZoneContext.TimeZoneDefinition.Id).toBe("Central Standard Time");
    expect(e.Body).toEqual({ __type: "FindItemRequest:#Exchange", Traversal: "Shallow" });
  });
  it("sends a whole envelope as given", () => {
    const whole = { Header: { x: 1 }, Body: { y: 2 } };
    expect(envelope("FindItem", whole)).toBe(whole);
  });
});

describe("owaCall", () => {
  it("sends the action with the browser's token and Outlook's headers", async () => {
    const fetch = vi.fn(async () => response(200, { Body: { ok: true } }));
    const result = await owaCall({ token: async () => token(1), fetch: fetch as never }, "GetItem", {});
    expect(result.body).toEqual({ Body: { ok: true } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://outlook.cloud.microsoft/owa/service.svc?action=GetItem&app=Mail");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer t1");
    expect(headers.action).toBe("GetItem");
    expect(headers["x-anchormailbox"]).toBe("PUID:1@tenant");
    expect(JSON.parse(String(init.body)).Body.__type).toBe("GetItemRequest:#Exchange");
  });
  it("retries once on a fresh token after a 401", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("", { status: 401 })).mockResolvedValueOnce(response(200, { Body: {} }));
    const tokens = vi.fn(async (fresh: boolean) => token(fresh ? 2 : 1));
    await owaCall({ token: tokens, fetch: fetch as never }, "FindItem", {});
    expect(tokens.mock.calls).toEqual([[false], [true]]);
    expect(((fetch.mock.calls[1] as any)[1].headers as Record<string, string>).authorization).toBe("Bearer t2");
  });
  it("gives up after the retry", async () => {
    const fetch = vi.fn(async () => new Response("", { status: 401 }));
    await expect(owaCall({ token: async () => token(1), fetch: fetch as never }, "FindItem", {})).rejects.toMatchObject({ code: "OWA_UNAUTHORIZED" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reports other HTTP errors without retrying", async () => {
    const fetch = vi.fn(async () => response(500, { Body: { ExceptionName: "X" } }));
    await expect(owaCall({ token: async () => token(1), fetch: fetch as never }, "FindItem", {})).rejects.toMatchObject({ code: "OWA_HTTP_ERROR", status: 500 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("sends actions to the path Outlook serves them from", async () => {
    const fetch = vi.fn(async () => response(200, {}));
    await owaCall({ token: async () => token(1), fetch: fetch as never }, "GetTimeZoneOffsets", {});
    expect((fetch.mock.calls[0] as any)[0]).toBe("https://outlook.cloud.microsoft/owa/published/service.svc?action=GetTimeZoneOffsets&app=Mail");
  });
  it("refuses an action name that is not one", async () => {
    await expect(owaCall({ token: async () => token(1) }, "Find Item?x=1", {})).rejects.toBeInstanceOf(OwaError);
  });
});

describe("helpers", () => {
  it("strips __type markers", () => {
    expect(stripTypes({ __type: "a", x: [{ __type: "b", y: 1 }] })).toEqual({ x: [{ y: 1 }] });
  });
  it("throws the first error response message", () => {
    const body = { Body: { ResponseMessages: { Items: [{ ResponseClass: "Error", ResponseCode: "ErrorItemNotFound", MessageText: "gone" }] } } };
    expect(() => expectSuccess("GetItem", body)).toThrow(/gone/);
    expect(expectSuccess("GetItem", { Body: { ResponseMessages: { Items: [{ ResponseClass: "Success" }] } } })).toHaveLength(1);
  });
  it("reads a JWT's expiry", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 1_800_000_000 })).toString("base64url");
    expect(jwtExpiry(`h.${payload}.s`)).toBe(1_800_000_000_000);
    expect(jwtExpiry("not-a-jwt")).toBeUndefined();
  });
});

describe("sideEffect", () => {
  it("flags QueryString searches, bare or in an envelope", () => {
    expect(sideEffect("FindItem", { QueryString: "x" })).toMatch(/EWS Search/);
    expect(sideEffect("FindItem", { Header: {}, Body: { QueryString: { Value: "x" } } })).toMatch(/EWS Search/);
    expect(sideEffect("FindItem", { Restriction: {} })).toBeUndefined();
    expect(sideEffect("GetItem", { QueryString: "x" })).toBeUndefined();
  });
});
