import { describe, expect, it, vi } from "vitest";
import type { CdpTab } from "./cdp-driver.js";
import { parseOutlookStartup, watchOutlookStartup } from "./outlook-startup.js";

const email = "student@vanderbilt.edu";
const fixture = {
  owaUserConfig: { SessionSettings: { UserEmailAddress: email.toUpperCase() } },
};

describe("Outlook startup identity", () => {
  it("accepts the configured mailbox's startup data and ignores anything else", () => {
    expect(parseOutlookStartup(fixture, email)).toBe(true);
    expect(parseOutlookStartup({}, email)).toBeUndefined();
  });

  it("rejects a different signed-in mailbox", () => {
    expect(() => parseOutlookStartup(fixture, "other@vanderbilt.edu")).toThrow("OUTLOOK_ACCOUNT_MISMATCH");
  });

  it("reads only a completed Outlook startup response, including its JavaScript MIME type", async () => {
    let emit!: NonNullable<Parameters<NonNullable<CdpTab["onEvent"]>>[0]>;
    const send = vi.fn(async () => ({ body: JSON.stringify(fixture), base64Encoded: false }));
    const read = await watchOutlookStartup({
      tabId: "synthetic",
      evaluate: async () => undefined,
      send: send as CdpTab["send"],
      onEvent: listener => { emit = listener; },
    }, email);
    const response = (origin: string, status: number) => ({
      url: origin + "/owa/0/startupdata.ashx", status, mimeType: "application/x-javascript",
    });
    emit("Network.responseReceived", { requestId: "wrong-host", response: response("https://example.test", 200) });
    emit("Network.responseReceived", { requestId: "unauthorized", response: response("https://outlook.cloud.microsoft", 401) });
    emit("Network.loadingFinished", { requestId: "wrong-host" });
    emit("Network.loadingFinished", { requestId: "unauthorized" });
    expect(send).toHaveBeenCalledTimes(1);
    emit("Network.responseReceived", { requestId: "mail", response: response("https://outlook.cloud.microsoft", 200) });
    emit("Network.loadingFinished", { requestId: "mail" });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith("Network.getResponseBody", { requestId: "mail" });
    expect(read()).toBe(true);
  });
});
