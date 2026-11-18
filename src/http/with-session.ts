/**
 * Run a read against a live stored session. ensureSession returns the cached session when its
 * liveness probe passes and mints one otherwise; if the service still bounces the request to the
 * IdP's sign-in page (the session died between the probe and the read), the session is re-minted
 * once and the read retried. Any other failure surfaces as is, so a 404 never burns a session.
 */
import type { Context } from "../toolfactory/types.js";
import type { Idp } from "../vault/index.js";
import type { CookieRecord } from "../vault/file-store.js";
import { sessionStore } from "../vault/file-store.js";
import { credentialEnv } from "../vault/credential-store.js";
import { ensureSession } from "../sso/ensure.js";
import { SessionExpiredError, type SessionResponse } from "./session-fetch.js";

export const vaultStore = (ctx: Context) => sessionStore(ctx.dataDir, credentialEnv(ctx.config));

/**
 * Ensure the listed sessions, then call `read` with the cookies of every stored session: a
 * Microsoft sign-in for a Vanderbilt account federates through OneVU, so a dance may need both.
 */
export async function withSession<T>(ctx: Context, idps: readonly Idp[], read: (cookies: CookieRecord[]) => Promise<T>): Promise<T> {
  const store = vaultStore(ctx);
  for (const idp of idps) await ensureSession(idp, store);
  const cookies = () => (["vanderbilt", "microsoft"] as const).flatMap((idp) => store.cookies(idp));
  try {
    return await read(cookies());
  } catch (error) {
    if (!(error instanceof SessionExpiredError)) throw error;
    const idp = error.idp ?? idps[0];
    await ensureSession(idp, store, { forceRefresh: true });
    return read(cookies());
  }
}

const BEARER_NOTE =
  "401 with a Microsoft session minted for this request: this endpoint wants an OAuth bearer token (Outlook REST, Microsoft Graph and Outlook's own service calls do), which the signed-in session's cookies cannot supply. Open Outlook in the signed-in browser instead.";

/**
 * `request` on the stored sessions. A 401 from a Microsoft 365 host is how Outlook and the other
 * Microsoft APIs refuse a request instead of redirecting to sign-in. When the request went out on
 * a session minted before this call, the session is re-minted and the request sent once more; when
 * the 401 came back on a session minted for this call (sessions.ensure re-harvests Microsoft after
 * two minutes), re-minting cannot help and the 401 is returned with a trace line saying why.
 */
export async function requestWithSession(
  ctx: Context,
  owner: Idp,
  send: (cookies: CookieRecord[]) => Promise<SessionResponse>,
): Promise<SessionResponse> {
  const store = vaultStore(ctx);
  const acquiredAt = async () => (await store.get("microsoft"))?.acquiredAt;
  const before = owner === "microsoft" ? await acquiredAt() : undefined;
  const res = await withSession(ctx, [owner], send);
  if (res.status !== 401 || owner !== "microsoft") return res;
  const after = await acquiredAt();
  if (after !== undefined && after !== before) return { ...res, trace: [...res.trace, BEARER_NOTE] };
  await ensureSession("microsoft", store, { forceRefresh: true });
  const retried = await withSession(ctx, [owner], send);
  const trace = [...res.trace, "401: re-minted the Microsoft session and sent the request again", ...retried.trace];
  return { ...retried, trace: retried.status === 401 ? [...trace, BEARER_NOTE] : trace };
}
