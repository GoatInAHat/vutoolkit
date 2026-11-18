/**
 * withSession re-mints only when the service sent the request to the IdP's sign-in page: any other
 * failure (a 404, a parse error) must surface untouched instead of burning a working session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "./session-fetch.js";

const ensureSession = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../sso/ensure.js", () => ({ ensureSession: (...args: unknown[]) => ensureSession(...args) }));
let acquired: string[] = [];
vi.mock("../vault/file-store.js", () => ({ sessionStore: () => ({ cookies: () => [], get: async () => (acquired.length ? { acquiredAt: acquired.shift() } : null) }) }));
const { requestWithSession, withSession } = await import("./with-session.js");
const ctx = { dataDir: "/tmp/unused", config: {} };

describe("withSession", () => {
  afterEach(() => vi.clearAllMocks());

  it("rethrows a failure that is not a refused session, without re-minting", async () => {
    const boom = new Error("HTTP 404");
    const read = vi.fn(async () => { throw boom; });
    await expect(withSession(ctx, ["vanderbilt"], read)).rejects.toBe(boom);
    expect(read).toHaveBeenCalledTimes(1);
    expect(ensureSession).toHaveBeenCalledTimes(1);
  });

  it("re-mints the refused session once and retries", async () => {
    const read = vi.fn(async () => "ok");
    read.mockRejectedValueOnce(new SessionExpiredError("login.microsoftonline.com"));
    await expect(withSession(ctx, ["vanderbilt"], read)).resolves.toBe("ok");
    expect(read).toHaveBeenCalledTimes(2);
    expect(ensureSession).toHaveBeenLastCalledWith("microsoft", expect.anything(), { forceRefresh: true });
  });
});

describe("requestWithSession", () => {
  afterEach(() => vi.clearAllMocks());
  const response = (status: number) => ({ status, url: "https://outlook.office.com/api/v2.0/me/messages", contentType: "", headers: {}, text: "", trace: [`${status} outlook.office.com/api/v2.0/me/messages`] });

  it("re-mints a Microsoft session from before this call after a 401, and sends the request once more", async () => {
    acquired = ["t0", "t0"];
    const send = vi.fn(async () => response(200));
    send.mockResolvedValueOnce(response(401));
    const res = await requestWithSession(ctx, "microsoft", send);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ensureSession).toHaveBeenCalledWith("microsoft", expect.anything(), { forceRefresh: true });
    expect(res.trace.join("\n")).toMatch(/re-minted/);
    expect(res.trace.join("\n")).not.toMatch(/bearer token/);
  });

  it("says the endpoint wants a bearer token when the retry on a fresh session is still 401", async () => {
    acquired = ["t0", "t0"];
    const send = vi.fn(async () => response(401));
    const res = await requestWithSession(ctx, "microsoft", send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(res.trace.at(-1)).toMatch(/bearer token/);
  });

  it("does not re-mint again when the 401 came back on a session minted for this request", async () => {
    acquired = ["t0", "t1"];
    const send = vi.fn(async () => response(401));
    const res = await requestWithSession(ctx, "microsoft", send);
    expect(res.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ensureSession).not.toHaveBeenCalledWith("microsoft", expect.anything(), { forceRefresh: true });
    expect(res.trace.at(-1)).toMatch(/bearer token/);
  });

  it("leaves other statuses and Vanderbilt responses alone", async () => {
    acquired = ["t0", "t0"];
    const other = vi.fn(async () => response(404));
    await requestWithSession(ctx, "microsoft", other);
    const vu = vi.fn(async () => response(401));
    await requestWithSession(ctx, "vanderbilt", vu);
    expect(other).toHaveBeenCalledTimes(1);
    expect(vu).toHaveBeenCalledTimes(1);
    expect(ensureSession).not.toHaveBeenCalledWith("microsoft", expect.anything(), { forceRefresh: true });
  });
});
