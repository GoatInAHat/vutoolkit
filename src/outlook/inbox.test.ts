import { describe, expect, it, vi } from "vitest";
import type { CdpTab } from "../sso/cdp-driver.js";
import { parseOutlookStartup, watchOutlookInbox } from "./inbox.js";

const email = "student@vanderbilt.edu";
const fixture = {
  owaUserConfig: { SessionSettings: { UserEmailAddress: email.toUpperCase() } },
  findConversation: { Body: { ResponseCode: "NoError", Conversations: [{
    ConversationTopic: "Synthetic subject",
    LastSender: { Mailbox: { Name: "Example Sender", EmailAddress: "sender@example.test" } },
    LastDeliveryTime: "2026-01-01T00:00:00Z",
    MessageCount: 1,
    UnreadCount: 0,
    Preview: "Private body preview",
  }] } },
};

describe("Outlook inbox startup", () => {
  it("only exposes inbox summary fields for the configured mailbox", () => {
    expect(parseOutlookStartup(fixture, email)).toEqual({ inbox: [{
      subject: "Synthetic subject",
      sender: { name: "Example Sender", email: "sender@example.test" },
      receivedAt: "2026-01-01T00:00:00Z",
      messageCount: 1,
      unreadCount: 0,
    }] });
  });

  it("distinguishes an empty inbox and a signed-out shell", () => {
    expect(parseOutlookStartup({ ...fixture, findConversation: {
      Body: { ResponseCode: "NoError", Conversations: [] },
    } }, email)).toEqual({ inbox: [] });
    expect(parseOutlookStartup({}, email)).toBeUndefined();
  });

  it("rejects a different signed-in mailbox", () => {
    expect(() => parseOutlookStartup(fixture, "other@vanderbilt.edu")).toThrow("OUTLOOK_ACCOUNT_MISMATCH");
  });

  it("reads only a completed Outlook startup response, including its JavaScript MIME type", async () => {
    let emit!: NonNullable<Parameters<NonNullable<CdpTab["onEvent"]>>[0]>;
    const send = vi.fn(async () => ({ body: JSON.stringify(fixture), base64Encoded: false }));
    const read = await watchOutlookInbox({
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
    expect(read()?.inbox?.[0]?.subject).toBe("Synthetic subject");
  });
});
