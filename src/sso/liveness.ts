/**
 * Session liveness: cookie expiry is not liveness. An Okta/Entra session can idle out
 * server-side while its cookies still carry a far-future `expires`, so a store row can look
 * fresh and still be dead. These probes ask the real service whether the session works, so
 * sessions.ensure can re-mint a dead-but-unexpired session instead of handing the agent cookies
 * that fail on first use.
 *
 * Each probe is a cheap authenticated GET through the session's own cookies. It never logs or
 * echoes cookie values, and a network error is treated as "not proven alive" (re-mint), never as
 * a false healthy.
 */
import { createHash, randomBytes } from "node:crypto";
import type { CookieRecord } from "../vault/file-store.js";
import type { Idp } from "../vault/index.js";
import { CookieJar, sessionFetch } from "../http/session-fetch.js";
import { discoverRecordFragmentUrl } from "../yes/aai-record.js";

import { AAI_SHELL_URL } from "../yes/client.js";

export type LivenessProbe = (idp: Idp, cookies: CookieRecord[], fetchImpl?: typeof fetch) => Promise<boolean>;
/**
 * Alive iff the danced aai shell returns with its academic-record hx-get URL present. A dead
 * session is redirected to the OneVU sign-in widget (onevu authorize), whose HTML carries no
 * such URL — the exact condition that makes record.fetch fail with "no hx-get URL".
 */
export async function probeVanderbilt(cookies: CookieRecord[], fetchImpl?: typeof fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  try {
    const res = await sessionFetch({ url: AAI_SHELL_URL }, { jar: new CookieJar(cookies), fetchImpl });
    if (res.status !== 200) return false;
    if (new URL(res.url).hostname !== "aai.app.vanderbilt.edu") return false;
    return discoverRecordFragmentUrl(res.text) !== null;
  } catch {
    return false;
  }
}

/** Outlook on the web's own sign-in client and redirect, as its MSAL.js uses them (observed 2026-11-18). */
const OUTLOOK_CLIENT_ID = "9199bf20-a13f-4107-85dc-02114787ef48";
const OUTLOOK_REDIRECT = "https://outlook.cloud.microsoft/mail/";
const MICROSOFT_AUTHORIZE = "https://login.microsoftonline.com/vanderbilt.edu/oauth2/v2.0/authorize";

/** The silent-authentication request (OpenID Connect prompt=none) the probe sends. */
export function microsoftSilentAuthorizeUrl(): string {
  const random = () => randomBytes(32).toString("base64url");
  const params = new URLSearchParams({
    client_id: OUTLOOK_CLIENT_ID,
    response_type: "code",
    redirect_uri: OUTLOOK_REDIRECT,
    scope: "openid profile",
    response_mode: "fragment",
    prompt: "none",
    state: random(),
    nonce: random(),
    // A fresh, discarded verifier: the code this may issue can never be redeemed.
    code_challenge: createHash("sha256").update(random()).digest("base64url"),
    code_challenge_method: "S256",
  });
  return `${MICROSOFT_AUTHORIZE}?${params}`;
}

/** true when the redirect carries an authorization code, false when it carries an error; null otherwise. */
export function silentAuthorizeOutcome(location: string | null): boolean | null {
  if (!location) return null;
  let target: URL;
  try {
    target = new URL(location, MICROSOFT_AUTHORIZE);
  } catch {
    return null;
  }
  if (target.origin !== new URL(OUTLOOK_REDIRECT).origin) return null;
  const params = new URLSearchParams(target.hash.slice(1) || target.search.slice(1));
  if (params.has("error")) return false;
  return params.has("code") ? true : null;
}

/**
 * Alive iff Microsoft's sign-in service, shown only the stored cookies, silently issues Outlook a
 * sign-in (OpenID Connect prompt=none) instead of asking for one. That is the check Outlook's own
 * page makes before it decides whether to show the account picker. Nothing is redeemed: the PKCE
 * verifier is thrown away, the redirect is never followed, and no URL is logged or returned.
 */
export async function probeMicrosoft(cookies: CookieRecord[], fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  const jar = new CookieJar(cookies);
  let url = microsoftSilentAuthorizeUrl();
  try {
    // Microsoft may bounce within its own sign-in host (e.g. to reprocess) before answering.
    for (let hop = 0; hop < 4; hop++) {
      const cookie = jar.headerFor(url);
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: { "user-agent": PROBE_UA, ...(cookie ? { cookie } : {}) },
      });
      jar.absorb(url, typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      const outcome = silentAuthorizeOutcome(location);
      if (outcome !== null) return outcome;
      if (!location) return false;
      const next = new URL(location, url);
      if (next.hostname !== "login.microsoftonline.com") return false;
      url = next.href;
    }
  } catch {
    return false;
  }
  return false;
}

const PROBE_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** The live check for each IdP's stored cookies. */
export const probeSession: LivenessProbe = (idp, cookies, fetchImpl) =>
  idp === "microsoft" ? probeMicrosoft(cookies, fetchImpl) : probeVanderbilt(cookies, fetchImpl);
