import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeSecrets } from "./credential-store.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("native secret CLI boundary", () => {
  it("puts values only in stdin and suppresses process output", () => {
    nativeSecrets.write("SYNTHETIC_CACHE", "synthetic-private-envelope");
    expect(execFileSync).toHaveBeenCalledWith("openclaw", ["secrets", "store", "set", "SYNTHETIC_CACHE", "--kind", "env", "--value-file", "-"], expect.objectContaining({ input: "synthetic-private-envelope", stdio: ["pipe", "ignore", "ignore"], timeout: 20_000 }));
  });

  it("treats only native missing-entry exit 3 as empty and sanitizes other failures", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("sensitive stderr"), { status: 3 }); });
    expect(nativeSecrets.read("SYNTHETIC_CACHE")).toBeNull();
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error("sensitive stderr"), { status: 2 }); });
    expect(() => nativeSecrets.read("SYNTHETIC_CACHE")).toThrow("Native credential vault read failed; no filesystem fallback was used.");
    expect(() => nativeSecrets.write("SYNTHETIC_CACHE", "synthetic-private-envelope")).toThrow("Native credential vault write failed; no credential was written to a cache file.");
  });
});
