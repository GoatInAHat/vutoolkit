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
import type { CookieRecord } from "../vault/file-store.js";
import type { Idp } from "../vault/index.js";
import { CookieJar, jarFetch } from "../yes/jar.js";
import { discoverRecordFragmentUrl } from "../yes/aai-record.js";

/** The aai shell: a live Vanderbilt session lands here with its academic-record hx-get URL. */
const AAI_SHELL_URL = "https://aai.app.vanderbilt.edu/aai";
/** A live Microsoft session completes this silent authorize; a dead one bounces to sign-in. */
const MICROSOFT_PROBE_URL = "https://www.office.com/?auth=2";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export type LivenessProbe = (idp: Idp, cookies: CookieRecord[], fetchImpl?: typeof fetch) => Promise<boolean>;

/**
 * Alive iff the danced aai shell returns with its academic-record hx-get URL present. A dead
 * session is redirected to the OneVU sign-in widget (onevu authorize), whose HTML carries no
 * such URL — the exact condition that makes record.fetch fail with "no hx-get URL".
 */
export async function probeVanderbilt(cookies: CookieRecord[], fetchImpl?: typeof fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  try {
    const res = await jarFetch(AAI_SHELL_URL, {
      jar: new CookieJar(cookies),
      headers: { "user-agent": BROWSER_UA },
      fetchImpl,
    });
    if (res.status !== 200) return false;
    if (new URL(res.finalUrl).hostname !== "aai.app.vanderbilt.edu") return false;
    return discoverRecordFragmentUrl(res.text) !== null;
  } catch {
    return false;
  }
}

/**
 * Alive iff the office.com silent authorize returns to office.com. A dead session lands on the
 * AAD sign-in page (login.microsoftonline.com / login.live.com), which is the honest death
 * signal — the outlook SPA shell itself renders either way, so it cannot be probed directly.
 */
export async function probeMicrosoft(cookies: CookieRecord[], fetchImpl?: typeof fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  try {
    const res = await jarFetch(MICROSOFT_PROBE_URL, {
      jar: new CookieJar(cookies),
      headers: { "user-agent": BROWSER_UA },
      fetchImpl,
    });
    if (res.status !== 200) return false;
    const host = new URL(res.finalUrl).hostname;
    return !(/(^|\.)login\.microsoftonline\.com$/.test(host) || /(^|\.)login\.live\.com$/.test(host));
  } catch {
    return false;
  }
}

/** Dispatch to the IdP's probe. Default liveness check used by sessions.ensure. */
export const probeSession: LivenessProbe = (idp, cookies, fetchImpl) =>
  idp === "microsoft" ? probeMicrosoft(cookies, fetchImpl) : probeVanderbilt(cookies, fetchImpl);
