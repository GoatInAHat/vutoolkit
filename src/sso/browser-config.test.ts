import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBrowser, resolveBrowser } from "./browser-config.js";
import { cdpReachable } from "./cdp-driver.js";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const managed = (profile = "work", port = 19400) => ({ profile, driver: "openclaw", cdpUrl: `http://127.0.0.1:${port}`, attachOnly: false });
afterEach(() => vi.unstubAllGlobals());

describe("browser selection and recovery", () => {
  it("allows the host to answer native CLI callbacks during discovery and startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vutoolkit-browser-rpc-"));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(managed("rpc", 19991)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const oldPath = process.env.PATH;
    try {
      await writeFile(join(dir, "openclaw"), `#!${process.execPath}\nfetch('http://127.0.0.1:${address.port}/' + process.argv.at(-1)).then(r => r.text()).then(t => process.stdout.write(t));\n`, { mode: 0o700 });
      process.env.PATH = `${dir}:${oldPath}`;
      const browser = await resolveBrowser({});
      expect(browser.profile).toBe("rpc");
      await ensureBrowser(browser, { reachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
      expect(requests).toEqual(["/status", "/start"]);
    } finally {
      process.env.PATH = oldPath;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
  it("honors explicit CDP without native discovery and never launches a different browser on failure", async () => {
    const status = vi.fn();
    const start = vi.fn();
    const selected = await resolveBrowser({ VUTOOLKIT_CDP_URL: "https://cdp.example.test:9443" }, { status });
    expect(status).not.toHaveBeenCalled();
    await expect(ensureBrowser(selected, { reachable: async () => false, start })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE", retryable: false });
    expect(start).not.toHaveBeenCalled();
  });
  it("uses configured default profile and its actual nonstandard port", async () => {
    const status = vi.fn(() => managed());
    const selected = await resolveBrowser({}, { status });
    expect(selected).toMatchObject({ profile: "work", cdpUrl: "http://127.0.0.1:19400", source: "default" });
    expect(status).toHaveBeenCalledWith(undefined);
    const start = vi.fn();
    await ensureBrowser(selected, { start, reachable: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
    expect(start).toHaveBeenCalledExactlyOnceWith("work");
  });
  it("respects explicit named profile", async () => {
    const status = vi.fn(() => managed("school", 19990));
    expect(await resolveBrowser({ VUTOOLKIT_BROWSER_PROFILE: "school" }, { status })).toMatchObject({ cdpUrl: "http://127.0.0.1:19990", source: "profile" });
    expect(status).toHaveBeenCalledExactlyOnceWith("school");
  });
  it("rejects incompatible explicit profile without probing another profile", async () => {
    const status = vi.fn(() => ({ profile: "user", driver: "existing-session" }));
    await expect(resolveBrowser({ VUTOOLKIT_BROWSER_PROFILE: "user" }, { status })).rejects.toThrow(/full Chromium CDP/);
    expect(status).toHaveBeenCalledTimes(1);
  });
  it("falls back only when implicit default has an incompatible adapter", async () => {
    const status = vi.fn().mockReturnValueOnce({ profile: "chrome", driver: "extension" }).mockReturnValueOnce(managed("openclaw", 18805));
    expect(await resolveBrowser({}, { status })).toMatchObject({ profile: "openclaw", source: "fallback", cdpUrl: "http://127.0.0.1:18805" });
    expect(status).toHaveBeenLastCalledWith("openclaw");
  });
  it("does not start attach-only or remote configured profiles", async () => {
    for (const info of [{ ...managed(), attachOnly: true }, { ...managed(), cdpUrl: "http://remote.example.test:9222" }]) {
      const selected = await resolveBrowser({}, { status: () => info });
      const start = vi.fn();
      await expect(ensureBrowser(selected, { start, reachable: async () => false })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
      expect(start).not.toHaveBeenCalled();
    }
  });
  it("does not fall back when native discovery fails or browser control is disabled", async () => {
    const status = vi.fn(() => { throw new Error("unavailable"); });
    await expect(resolveBrowser({}, { status })).rejects.toThrow("unavailable");
    expect(status).toHaveBeenCalledTimes(1);
    await expect(resolveBrowser({}, { status: () => ({ enabled: false }) })).rejects.toThrow(/disabled/);
  });
  it("rejects WebSocket endpoint config and redacts credential-bearing invalid URLs", async () => {
    await expect(resolveBrowser({ VUTOOLKIT_CDP_URL: "wss://secret-user:secret-value@example.test/ws" })).rejects.toThrow(/HTTP\(S\)/);
    try { await resolveBrowser({ VUTOOLKIT_CDP_URL: "wss://secret-user:secret-value@example.test/ws" }); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
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
