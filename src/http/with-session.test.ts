/**
 * withSession re-mints only when the service sent the request to the IdP's sign-in page: any other
 * failure (a 404, a parse error) must surface untouched instead of burning a working session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionExpiredError } from "./session-fetch.js";

const ensureSession = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("../sso/ensure.js", () => ({ ensureSession: (...args: unknown[]) => ensureSession(...args) }));
vi.mock("../vault/file-store.js", () => ({ sessionStore: () => ({ cookies: () => [] }) }));
const { withSession } = await import("./with-session.js");
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
