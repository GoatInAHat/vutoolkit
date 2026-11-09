import { z } from "zod";
import { withCdpTab, type CdpTab } from "../sso/cdp-driver.js";
import { AuthError } from "../sso/errors.js";

export const OUTLOOK_INBOX = "https://outlook.office.com/mail/0/inbox/";

const conversation = z.object({
  ConversationTopic: z.string().optional(),
  LastSender: z.object({
    Mailbox: z.object({ Name: z.string().optional(), EmailAddress: z.string().optional() }).optional(),
  }).optional(),
  LastDeliveryTime: z.string().optional(),
  UnreadCount: z.number().optional(),
  MessageCount: z.number().optional(),
});
const startup = z.object({
  owaUserConfig: z.object({
    SessionSettings: z.object({
      UserPrincipalName: z.string().optional(),
      UserEmailAddress: z.string().optional(),
    }),
  }),
  findConversation: z.unknown(),
});

export const inboxConversation = z.object({
  subject: z.string().optional(),
  sender: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  receivedAt: z.string().optional(),
  unreadCount: z.number().optional(),
  messageCount: z.number().optional(),
});

const inboxResponse = z.object({
  Body: z.object({ ResponseCode: z.literal("NoError"), Conversations: z.array(conversation) }),
});

export function parseOutlookStartup(body: unknown, email: string) {
  const result = startup.safeParse(body);
  if (!result.success) return undefined;
  const { UserPrincipalName, UserEmailAddress } = result.data.owaUserConfig.SessionSettings;
  if (![UserPrincipalName, UserEmailAddress].some(value => value?.toLowerCase() === email.toLowerCase())) {
    throw new AuthError("OUTLOOK_ACCOUNT_MISMATCH", "The Outlook mailbox does not match the configured Vanderbilt account.", { retryable: false });
  }
  const response = inboxResponse.safeParse(result.data.findConversation);
  const inbox = response.success ? response.data.Body.Conversations.map(item => ({
    subject: item.ConversationTopic,
    sender: item.LastSender?.Mailbox && {
      name: item.LastSender.Mailbox.Name,
      email: item.LastSender.Mailbox.EmailAddress,
    },
    receivedAt: item.LastDeliveryTime,
    unreadCount: item.UnreadCount,
    messageCount: item.MessageCount,
  })) : undefined;
  return { inbox };
}

const STARTUP_URLS = new Set([
  "https://outlook.cloud.microsoft",
  "https://outlook.office.com",
  "https://outlook.office365.com",
]);

/** Observe Outlook's own inbox startup request. Do not collect or replay its authorization header. */
export async function watchOutlookInbox(tab: CdpTab, email: string) {
  let startup: ReturnType<typeof parseOutlookStartup>;
  let failure: AuthError | undefined;
  const pending = new Set<string>();
  tab.onEvent?.((method, params) => {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    if (method === "Network.responseReceived") {
      const response = params.response as { url: string; status: number };
      const url = new URL(response.url);
      if (response.status === 200 &&
          STARTUP_URLS.has(url.origin) && /^\/owa\/(?:0\/)?startupdata\.ashx$/i.test(url.pathname)) {
        pending.add(requestId);
      }
      return;
    }
    if (method === "Network.loadingFailed") pending.delete(requestId);
    if (method !== "Network.loadingFinished" || !pending.delete(requestId)) return;
    void tab.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId }).then(response => {
      const body = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
      startup = parseOutlookStartup(JSON.parse(body), email) ?? startup;
    }).catch(error => {
      if (error instanceof AuthError) failure = error;
    });
  });
  await tab.send("Network.enable");
  return () => {
    if (failure) throw failure;
    return startup;
  };
}

export async function readOutlookInbox(cdpUrl: string, email: string, timeoutMs = 15_000) {
  return (await readOutlookStartup(cdpUrl, email, timeoutMs))?.inbox;
}

export async function readOutlookStartup(cdpUrl: string, email: string, timeoutMs = 15_000) {
  return withCdpTab(cdpUrl, "about:blank", async tab => {
    const read = await watchOutlookInbox(tab, email);
    await tab.send("Page.navigate", { url: OUTLOOK_INBOX });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const startup = read();
      if (startup) return startup;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return undefined;
  });
}
