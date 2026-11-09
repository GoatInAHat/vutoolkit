/**
 * record.fetch's retry must be auth-shaped: forgetting the cached vanderbilt session forces a
 * costly re-mint (full CDP/passkey ceremony), so a transient, non-auth failure from academicRecord
 * (e.g. an aai-record.ts parse hiccup) must bubble up untouched instead of burning a session that
 * was actually fine. Only a YesNotConfiguredError or an auth-shaped message retries once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { operations } from "./ops.js";
import { YesNotConfiguredError } from "./yes/client.js";

const forget = vi.fn(async () => {});
const cookies = vi.fn(() => []);
const academicRecord = vi.fn();

vi.mock("./sso/ensure.js", () => ({ ensureSession: vi.fn(async () => {}) }));
vi.mock("./vault/file-store.js", () => ({
  sessionStore: () => ({ cookies, forget }),
  harvestToStoredSession: vi.fn(),
}));
vi.mock("./yes/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./yes/client.js")>();
  return { ...actual, YesClient: vi.fn(function YesClient() { return { academicRecord }; }) };
});

const op = (name: string) => operations.find((o) => o.name === name)!;
const ctx = { dataDir: "/tmp/unused", config: {} };

describe("record.fetch retry", () => {
  afterEach(() => vi.clearAllMocks());

  it("rethrows a non-auth-shaped failure without forgetting the session", async () => {
    const boom = new Error("boom");
    academicRecord.mockRejectedValueOnce(boom);

    await expect(op("record.fetch").handler({} as never, ctx as never)).rejects.toBe(boom);
    expect(forget).not.toHaveBeenCalled();
    expect(academicRecord).toHaveBeenCalledTimes(1);
  });

  it("forgets and retries once on an auth-shaped failure, then resolves", async () => {
    const transcript = { terms: [] };
    academicRecord
      .mockRejectedValueOnce(new YesNotConfiguredError("needs a session"))
      .mockResolvedValueOnce(transcript);

    const result = await op("record.fetch").handler({} as never, ctx as never);

    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith("vanderbilt");
    expect(result).toEqual({ transcript, source: "live" });
  });
});
