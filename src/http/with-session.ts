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
import { SessionExpiredError } from "./session-fetch.js";

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
