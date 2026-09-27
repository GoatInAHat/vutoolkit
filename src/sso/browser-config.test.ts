import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBrowser, resolveBrowser } from "./browser-config.js";
import { cdpReachable } from "./cdp-driver.js";

const managed = (profile = "work", port = 19400) => ({ profile, driver: "openclaw", cdpUrl: `http://127.0.0.1:${port}`, attachOnly: false });
afterEach(() => vi.unstubAllGlobals());

describe("browser selection and recovery", () => {
  it("honors explicit CDP without native discovery and never launches a different browser on failure", async () => {
    const status = vi.fn();
    const start = vi.fn();
    const selected = resolveBrowser({ VUTOOLKIT_CDP_URL: "https://cdp.example.test:9443" }, { status });
    expect(status).not.toHaveBeenCalled();
    await expect(ensureBrowser(selected, { reachable: async () => false, start })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE", retryable: false });
    expect(start).not.toHaveBeenCalled();
  });
  it("uses configured default profile and its actual nonstandard port", async () => {
    const status = vi.fn(() => managed());
    const selected = resolveBrowser({}, { status });
    expect(selected).toMatchObject({ profile: "work", cdpUrl: "http://127.0.0.1:19400", source: "default" });
    expect(status).toHaveBeenCalledWith(undefined);
    const start = vi.fn();
    await ensureBrowser(selected, { start, reachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
    expect(start).toHaveBeenCalledExactlyOnceWith("work");
  });
  it("respects explicit named profile", () => {
    const status = vi.fn(() => managed("school", 19990));
    expect(resolveBrowser({ VUTOOLKIT_BROWSER_PROFILE: "school" }, { status })).toMatchObject({ cdpUrl: "http://127.0.0.1:19990", source: "profile" });
    expect(status).toHaveBeenCalledExactlyOnceWith("school");
  });
  it("rejects incompatible explicit profile without probing another profile", () => {
    const status = vi.fn(() => ({ profile: "user", driver: "existing-session" }));
    expect(() => resolveBrowser({ VUTOOLKIT_BROWSER_PROFILE: "user" }, { status })).toThrow(/full Chromium CDP/);
    expect(status).toHaveBeenCalledTimes(1);
  });
  it("falls back only when implicit default has an incompatible adapter", () => {
    const status = vi.fn().mockReturnValueOnce({ profile: "chrome", driver: "extension" }).mockReturnValueOnce(managed("openclaw", 18805));
    expect(resolveBrowser({}, { status })).toMatchObject({ profile: "openclaw", source: "fallback", cdpUrl: "http://127.0.0.1:18805" });
    expect(status).toHaveBeenLastCalledWith("openclaw");
  });
  it("does not start attach-only or remote configured profiles", async () => {
    for (const info of [{ ...managed(), attachOnly: true }, { ...managed(), cdpUrl: "http://remote.example.test:9222" }]) {
      const selected = resolveBrowser({}, { status: () => info });
      const start = vi.fn();
      await expect(ensureBrowser(selected, { start, reachable: async () => false })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
      expect(start).not.toHaveBeenCalled();
    }
  });
  it("does not fall back when native discovery fails or browser control is disabled", () => {
    const status = vi.fn(() => { throw new Error("unavailable"); });
    expect(() => resolveBrowser({}, { status })).toThrow("unavailable");
    expect(status).toHaveBeenCalledTimes(1);
    expect(() => resolveBrowser({}, { status: () => ({ enabled: false }) })).toThrow(/disabled/);
  });
  it("rejects WebSocket endpoint config and redacts credential-bearing invalid URLs", () => {
    expect(() => resolveBrowser({ VUTOOLKIT_CDP_URL: "wss://secret-user:secret-value@example.test/ws" })).toThrow(/HTTP\(S\)/);
    try { resolveBrowser({ VUTOOLKIT_CDP_URL: "wss://secret-user:secret-value@example.test/ws" }); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
  });
});

describe("CDP runtime readiness", () => {
  it("rejects ordinary HTTP 200 JSON that is not CDP", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ healthy: true })));
    expect(await cdpReachable("http://127.0.0.1:18800")).toBe(false);
  });
  it("accepts Chromium discovery with a protocol and websocket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ "Protocol-Version": "1.3", webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/browser/123" })));
    expect(await cdpReachable("http://127.0.0.1:18800")).toBe(true);
  });
});
