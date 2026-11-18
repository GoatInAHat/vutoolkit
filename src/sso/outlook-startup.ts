/**
 * Proof that a Microsoft mint reached the right mailbox: Outlook's own startup response names the
 * signed-in account. Used by the Entra carry before it harvests cookies.
 */
import type { CdpTab } from "./cdp-driver.js";
import { AuthError } from "./errors.js";
import { z } from "zod";

export const OUTLOOK_INBOX = "https://outlook.office.com/mail/0/inbox/";

const startup = z.object({
  owaUserConfig: z.object({
    SessionSettings: z.object({
      UserPrincipalName: z.string().optional(),
      UserEmailAddress: z.string().optional(),
    }),
  }),
});

/** true when this is the configured mailbox's startup data; undefined when it is not startup data; throws on another mailbox. */
export function parseOutlookStartup(body: unknown, email: string): true | undefined {
  const result = startup.safeParse(body);
  if (!result.success) return undefined;
  const { UserPrincipalName, UserEmailAddress } = result.data.owaUserConfig.SessionSettings;
  if (![UserPrincipalName, UserEmailAddress].some(value => value?.toLowerCase() === email.toLowerCase())) {
    throw new AuthError("OUTLOOK_ACCOUNT_MISMATCH", "The Outlook mailbox does not match the configured Vanderbilt account.", { retryable: false });
  }
  return true;
}

const STARTUP_URLS = new Set([
  "https://outlook.cloud.microsoft",
  "https://outlook.office.com",
  "https://outlook.office365.com",
]);

const debug = (message: string) => {
  if (process.env.VUTOOLKIT_DEBUG) process.stderr.write(`vutoolkit outlook startup: ${message}\n`);
};

/**
 * Observe Outlook's own inbox startup request. Do not collect or replay its authorization header.
 * The tab bypasses Outlook's service worker so the startup response comes from the network and its
 * body is readable over CDP.
 */
export async function watchOutlookStartup(tab: CdpTab, email: string) {
  let startup: ReturnType<typeof parseOutlookStartup>;
  let failure: AuthError | undefined;
  const pending = new Set<string>();
  tab.onEvent?.((method, params) => {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    if (method === "Network.responseReceived") {
      const response = params.response as { url: string; status: number };
      const url = new URL(response.url);
      if (STARTUP_URLS.has(url.origin) && /startupdata/i.test(url.pathname)) debug(`${response.status} ${url.origin}${url.pathname}`);
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
      else debug(`startup body unreadable: ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    });
  });
  await tab.send("Network.enable");
  await tab.send("Network.setBypassServiceWorker", { bypass: true });
  return () => {
    if (failure) throw failure;
    return startup;
  };
}
