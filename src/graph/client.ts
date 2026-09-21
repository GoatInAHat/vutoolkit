/**
 * One Graph call with the honest failure modes an agent can act on: a 401 re-mints the token
 * once (server-side revocation before expiry), a 429 honors Retry-After up to a bound and then
 * surfaces the throttling instead of hiding it. Only https://graph.microsoft.com/v1.0 is
 * reachable: the path is pinned to a relative v1.0 path, so no caller can steer a call
 * elsewhere.
 */
export type GraphMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const BASE = "https://graph.microsoft.com/v1.0";
const RETRY_AFTER_CAP_S = 30;
const MAX_THROTTLE_RETRIES = 2;

export interface GraphCallDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type TokenProvider = (opts: { force?: boolean }) => Promise<string>;

export interface GraphCallResult {
  status: number;
  data: unknown;
}

/** Build the request URL; throws on paths that try to leave the pinned Graph origin. */
export function graphUrl(path: string, query?: Record<string, string | number>): string {
  if (!/^\/[^\/]/.test(path)) {
    throw new TypeError("path must be a relative Graph v1.0 path like /me/messages");
  }
  const url = new URL(BASE + path);
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function graphCall(
  method: GraphMethod,
  path: string,
  query: Record<string, string | number> | undefined,
  body: unknown,
  getToken: TokenProvider,
  deps: GraphCallDeps = {},
): Promise<GraphCallResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const url = graphUrl(path, query);
  const headers: Record<string, string> = { authorization: "Bearer " + (await getToken({})) };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers["content-type"] = "application/json";

  let reminted = false;
  let throttled = 0;
  for (;;) {
    const res = await fetchImpl(url, { method, headers, body: payload });
    if (res.status === 401 && !reminted) {
      reminted = true;
      headers.authorization = "Bearer " + (await getToken({ force: true }));
      continue;
    }
    if (res.status === 429 && throttled < MAX_THROTTLE_RETRIES) {
      throttled++;
      const asked = parseInt(res.headers.get("retry-after") ?? "", 10);
      const waitS = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, RETRY_AFTER_CAP_S) : RETRY_AFTER_CAP_S;
      await sleep(waitS * 1000);
      continue;
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body stays text */
    }
    return { status: res.status, data };
  }
}
