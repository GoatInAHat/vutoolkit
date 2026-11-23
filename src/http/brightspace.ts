/**
 * Brightspace (D2L) on the stored session. Its API answers 403 instead of redirecting when the
 * request carries no Brightspace session, so a bare API call never starts the sign-in dance that a
 * page would; and its own pages send every API call with the `X-Csrf-Token` header, the token D2L
 * hands out at `/d2l/lp/auth/xsrf-tokens` (`referrerToken`, the value Brightspace's pages keep in
 * localStorage as `XSRF.Token`). `brightspaceFetch` does what those pages do: sign in to
 * Brightspace through its own login page when needed, take the token from that endpoint, and send
 * the request with it.
 *
 * The Brightspace cookies and token from a sign-in are kept in this process for a few minutes so
 * that a run of API calls signs in once. They never leave the process, and a 401 or 403 drops them
 * and signs in again once.
 */
import { CookieJar, sessionFetch, type SessionFetchOptions, type SessionRequest, type SessionResponse } from "./session-fetch.js";

/** Kept this long after a sign-in; D2L's own session lasts far longer. */
const CACHE_MS = 15 * 60_000;
const XSRF_PATH = "/d2l/lp/auth/xsrf-tokens";
const HOME_PATH = "/d2l/home";

/** A Vanderbilt Brightspace URL: the D2L app's paths on a Vanderbilt host. */
export function isBrightspace(url: string): boolean {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && (host === "vanderbilt.edu" || host.endsWith(".vanderbilt.edu")) && u.pathname.toLowerCase().startsWith("/d2l/");
}

interface Primed {
  cookies: { name: string; value: string; domain: string }[];
  token: string;
  at: number;
}
const primed = new Map<string, Primed>();

/** Forget every kept Brightspace sign-in (tests). */
export function forgetBrightspace(): void {
  primed.clear();
}

async function xsrfToken(origin: string, opts: SessionFetchOptions, trace: string[]): Promise<string> {
  const res = await sessionFetch({ url: origin + XSRF_PATH }, { ...opts, binary: false });
  trace.push(...res.trace);
  if (res.status !== 200) return "";
  try {
    const token = (JSON.parse(res.text) as { referrerToken?: unknown }).referrerToken;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

/**
 * Sign in to Brightspace in this jar (when D2L does not already know the session) and return its
 * CSRF token, or "" when D2L gave none. Throws SessionExpiredError when the sign-in ends on the IdP.
 */
async function prime(origin: string, opts: SessionFetchOptions, trace: string[]): Promise<string> {
  let token = await xsrfToken(origin, opts, trace);
  if (!token) {
    // An anonymous visitor gets an empty token: open Brightspace's home page, which signs in.
    const home = await sessionFetch({ url: origin + HOME_PATH }, { ...opts, binary: false });
    trace.push(...home.trace);
    token = await xsrfToken(origin, opts, trace);
  }
  return token;
}

/**
 * Send a request to Brightspace as its own pages do: signed in to Brightspace, with its CSRF token
 * (unless the caller set X-Csrf-Token). Other URLs go straight to sessionFetch. `scope` keeps one
 * student's kept sign-in apart from another's (the data directory).
 */
export async function brightspaceFetch(request: SessionRequest, opts: SessionFetchOptions, scope = ""): Promise<SessionResponse> {
  if (!isBrightspace(request.url) || new URL(request.url).pathname.toLowerCase() === XSRF_PATH) return sessionFetch(request, opts);
  const { origin } = new URL(request.url);
  // One student's sign-in is never handed to another's request: the key carries their data directory.
  const key = `${scope}|${new URL(request.url).host}`;
  const callerSetToken = Object.keys(request.headers ?? {}).some((k) => k.toLowerCase() === "x-csrf-token");
  const trace: string[] = [];

  const attempt = async (fresh: boolean): Promise<{ res: SessionResponse; cached: boolean }> => {
    let kept = fresh ? undefined : primed.get(key);
    if (kept && Date.now() - kept.at > CACHE_MS) kept = undefined;
    let token: string;
    if (kept) {
      opts.jar.add(kept.cookies);
      token = kept.token;
      trace.push("brightspace: reused this process's Brightspace sign-in");
    } else {
      token = await prime(origin, opts, trace);
      if (token) primed.set(key, { cookies: opts.jar.entriesFor(new URL(origin).hostname), token, at: Date.now() });
      else primed.delete(key);
      trace.push(token ? "brightspace: signed in and took Brightspace's CSRF token" : "brightspace: Brightspace gave no CSRF token; sent without one");
    }
    const headers = { ...(request.headers ?? {}), ...(token && !callerSetToken ? { "X-Csrf-Token": token } : {}) };
    const res = await sessionFetch({ ...request, headers }, opts);
    trace.push(...res.trace);
    return { res, cached: !!kept };
  };

  let { res, cached } = await attempt(false);
  if (cached && (res.status === 401 || res.status === 403)) {
    primed.delete(key);
    trace.push(`brightspace: ${res.status} on the kept sign-in; signing in again`);
    ({ res } = await attempt(true));
  }
  return { ...res, trace };
}
