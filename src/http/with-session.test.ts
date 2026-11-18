/**
 * withSession re-mints only when the service sent the request to the IdP's sign-in page: any other
 * failure (a 404, a parse error) must surface untouched instead of burning a working session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "./session-fetch.js";

const ensureSession = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../sso/ensure.js", () => ({ ensureSession: (...args: unknown[]) => ensureSession(...args) }));
vi.mock("../vault/file-store.js", () => ({ sessionStore: () => ({ cookies: () => [] }) }));
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

  it("re-mints a Microsoft session that Microsoft no longer accepts after a 401, and sends the request once more", async () => {
    const send = vi.fn(async () => response(200));
    send.mockResolvedValueOnce(response(401));
    const res = await requestWithSession(ctx, "microsoft", send, async () => false);
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ensureSession).toHaveBeenCalledWith("microsoft", expect.anything(), { forceRefresh: true });
    expect(res.trace.join("\n")).toMatch(/re-minted/);
  });

  it("does not burn a live session on an endpoint that wants a bearer token, and says so", async () => {
    const send = vi.fn(async () => response(401));
    const res = await requestWithSession(ctx, "microsoft", send, async () => true);
    expect(res.status).toBe(401);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ensureSession).not.toHaveBeenCalledWith("microsoft", expect.anything(), { forceRefresh: true });
    expect(res.trace.at(-1)).toMatch(/bearer token/);
  });

  it("leaves other statuses and Vanderbilt responses alone", async () => {
    const probe = vi.fn(async () => false);
    await requestWithSession(ctx, "microsoft", async () => response(404), probe);
    await requestWithSession(ctx, "vanderbilt", async () => response(401), probe);
    expect(probe).not.toHaveBeenCalled();
  });
});
