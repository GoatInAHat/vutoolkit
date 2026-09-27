import { afterEach, describe, expect, it, vi } from "vitest";
import { harvestCookies, withCdpTab } from "./cdp-driver.js";

const sent: Array<{ id: number; method: string; params: Record<string, unknown>; sessionId?: string }> = [];
let failedMethod: string | undefined;
class FakeSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send(raw: string) {
    const message = JSON.parse(raw) as typeof sent[number];
    sent.push(message);
    const results: Record<string, unknown> = {
      "Target.createBrowserContext": { browserContextId: "isolated-context" },
      "Target.createTarget": { targetId: "isolated-target" },
      "Target.attachToTarget": { sessionId: "isolated-session" },
      "Storage.getCookies": { cookies: [{ name: "synthetic", value: "test-only", domain: "example.test" }] },
    };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, ...(failedMethod === message.method ? { error: { message: "synthetic failure" } } : { result: results[message.method] ?? {} }) }) }));
  }
  close() { this.onclose?.(); }
}
function setup() {
  sent.length = 0;
  failedMethod = undefined;
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ "Protocol-Version": "1.3", webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/browser/synthetic" })));
}
afterEach(() => vi.unstubAllGlobals());
describe("isolated CDP tabs", () => {
  it("creates a fresh context, routes page commands and reads only that context's cookies", async () => {
    setup();
    const result = await withCdpTab("http://127.0.0.1:18800", "https://example.test", async (tab) => {
      expect(tab.tabId).toBe("isolated-target");
      await tab.send("Page.enable");
      return harvestCookies(tab.send);
    }, { isolated: true, keepOpen: true });
    expect(result[0]?.name).toBe("synthetic");
    expect(sent.find((call) => call.method === "Target.createBrowserContext")?.params).toEqual({ disposeOnDetach: true });
    expect(sent.find((call) => call.method === "Page.enable")?.sessionId).toBe("isolated-session");
    expect(sent.find((call) => call.method === "Storage.getCookies")).toMatchObject({ params: { browserContextId: "isolated-context" } });
    expect(sent.find((call) => call.method === "Storage.getCookies")?.sessionId).toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ method: "Target.disposeBrowserContext", params: { browserContextId: "isolated-context" } });
    expect(sent.some((call) => /clear.*Cookies|deleteCookies/i.test(call.method))).toBe(false);
  });
  it("disposes the context when attachment fails", async () => {
    setup();
    failedMethod = "Target.attachToTarget";
    await expect(withCdpTab("http://127.0.0.1:18800", "about:blank", async () => {}, { isolated: true })).rejects.toThrow(/attachToTarget/);
    expect(sent.at(-1)?.method).toBe("Target.disposeBrowserContext");
  });
  it("disposes the context when the ceremony fails", async () => {
    setup();
    await expect(withCdpTab("http://127.0.0.1:18800", "about:blank", async () => { throw new Error("assertion missing"); }, { isolated: true })).rejects.toThrow("assertion missing");
    expect(sent.at(-1)?.method).toBe("Target.disposeBrowserContext");
  });
});
