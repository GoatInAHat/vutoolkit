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
import { ensureGraphToken, GraphTokenCache } from "../graph/token.js";

/** The aai shell: a live Vanderbilt session lands here with its academic-record hx-get URL. */
const AAI_SHELL_URL = "https://aai.app.vanderbilt.edu/aai";
/** Probe ids are unique so parallel session checks never share an ephemeral token flight. */
let microsoftProbeSequence = 0;
/** A throttled proof GET is retried this many times, honoring retry-after up to the cap. */
const MICROSOFT_PROBE_THROTTLE_RETRIES = 2;
const PROBE_RETRY_AFTER_CAP_S = 30;

/** The liveness check must not persist an OAuth token; its cache exists only in memory. */
class MicrosoftProbeTokenCache extends GraphTokenCache {
  constructor() {
    super(`memory:vutoolkit-microsoft-probe-${++microsoftProbeSequence}`);
  }

  override read() {
    return null;
  }

  override async put(): Promise<void> {
    // Liveness only needs the token for this one proof request.
  }
}
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
 * Alive iff the stored cookies can mint a Graph token and call the read-only /me endpoint.
 * Outlook's auth=2 shell check stopped working when Microsoft changed its redirect chain; use
 * the same supported silent Graph flow as graph.call so session health matches actual toolkit use.
 * The short-lived proof token is deliberately kept only in memory.
 *
 * A 429 is throttling, not a dead session: the proof GET is retried a bounded number of times
 * honoring retry-after, so ensure never re-mints a healthy session just because the probe was
 * rate-limited (the same discipline graphCall applies). Other non-200s stay "not proven alive".
 */
export async function probeMicrosoft(cookies: CookieRecord[], fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>): Promise<boolean> {
  if (cookies.length === 0) return false;
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    const token = await ensureGraphToken(cookies, new MicrosoftProbeTokenCache(), { fetchImpl });
    for (let attempt = 0; attempt <= MICROSOFT_PROBE_THROTTLE_RETRIES; attempt++) {
      const res = await (fetchImpl ?? fetch)("https://graph.microsoft.com/v1.0/me?$select=id", {
        headers: { authorization: `Bearer ${token.accessToken}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 && attempt < MICROSOFT_PROBE_THROTTLE_RETRIES) {
        const asked = parseInt(res.headers.get("retry-after") ?? "", 10);
        await wait((Number.isFinite(asked) && asked >= 0 ? Math.min(asked, PROBE_RETRY_AFTER_CAP_S) : PROBE_RETRY_AFTER_CAP_S) * 1000);
        continue;
      }
      return res.status === 200;
    }
    return false;
  } catch {
    return false;
  }
}

/** Dispatch to the IdP's probe. Default liveness check used by sessions.ensure. */
export const probeSession: LivenessProbe = (idp, cookies, fetchImpl) =>
  idp === "microsoft" ? probeMicrosoft(cookies, fetchImpl) : probeVanderbilt(cookies, fetchImpl);
