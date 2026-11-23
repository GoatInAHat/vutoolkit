/**
 * One HTTP client for every service behind Vanderbilt SSO (OneVU/Okta) or Microsoft (Entra):
 * a request rides the stored session's cookies through whatever sign-in dance the service runs —
 * HTTP redirects, the SAML or OIDC form-post the IdP auto-submits, and the tiny JS/meta redirect
 * stubs some apps (Brightspace) answer with — and returns the service's own response untouched.
 *
 * Cookies are scoped per domain (RFC 6265 suffix rules) and absorbed at every hop. Values live
 * only inside the jar: nothing here logs, echoes or returns them, and Set-Cookie is dropped from
 * the headers handed back.
 */
import type { CookieRecord } from "../vault/file-store.js";

/** The IdP sign-in hosts. Landing on one of them means the stored session no longer works there. */
const SIGN_IN_HOSTS = new Set(["onevu.vanderbilt.edu", "login.microsoftonline.com", "login.microsoft.com", "login.live.com"]);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** The request ended on the IdP's sign-in page: the stored session must be re-minted. */
export class SessionExpiredError extends Error {
  /** The session that was refused, judged by the sign-in host the request ended on. */
  readonly idp: "vanderbilt" | "microsoft";
  constructor(readonly host: string) {
    super(`the stored session was not accepted: the request ended on the ${host} sign-in page`);
    this.name = "SessionExpiredError";
    this.idp = host.endsWith("vanderbilt.edu") ? "vanderbilt" : "microsoft";
  }
}

export class CookieJar {
  private readonly entries: { name: string; value: string; domain: string }[];

  constructor(cookies: readonly CookieRecord[] = []) {
    this.entries = cookies.map((c) => ({ name: c.name, value: c.value, domain: (c.domain ?? "").replace(/^\./, "").toLowerCase() }));
  }

  /** Name=value pairs in this URL's domain scope; empty string when nothing applies. */
  headerFor(url: string): string {
    const host = new URL(url).hostname.toLowerCase();
    return this.entries
      .filter((c) => c.domain !== "" && (host === c.domain || host.endsWith("." + c.domain)))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Copies of the cookies in this host's domain scope, for a short in-process cache. */
  entriesFor(host: string): { name: string; value: string; domain: string }[] {
    const h = host.toLowerCase();
    return this.entries.filter((c) => c.domain !== "" && (h === c.domain || h.endsWith("." + c.domain))).map((c) => ({ ...c }));
  }

  /** Add cookies taken with entriesFor; the same name and domain overwrites. */
  add(entries: readonly { name: string; value: string; domain: string }[]): void {
    for (const e of entries) {
      const i = this.entries.findIndex((c) => c.name === e.name && c.domain === e.domain);
      if (i >= 0) this.entries[i] = { ...e };
      else this.entries.push({ ...e });
    }
  }

  /** Merge Set-Cookie lines from a response; the same name and domain overwrites. */
  absorb(url: string, setCookies: readonly string[]): void {
    const host = new URL(url).hostname.toLowerCase();
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        if (k.trim().toLowerCase() === "domain" && v) domain = v.trim().replace(/^\./, "").toLowerCase();
      }
      const i = this.entries.findIndex((c) => c.name === name && c.domain === domain);
      if (i >= 0) this.entries[i] = { name, value, domain };
      else this.entries.push({ name, value, domain });
    }
  }
}

export interface SessionRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface SessionResponse {
  status: number;
  url: string;
  contentType: string;
  headers: Record<string, string>;
  text: string;
  /** One "STATUS host/path" line per hop: diagnostics without cookie values or query strings. */
  trace: string[];
  /** The final response's raw body, only when the request asked for `binary`. */
  bytes?: Uint8Array;
}

export interface SessionFetchOptions {
  jar: CookieJar;
  fetchImpl?: typeof fetch;
  maxHops?: number;
  /** Per-hop bound, body read included. */
  hopTimeoutMs?: number;
  /** Called before every hop is sent; throw to refuse it. */
  guard?: (url: string, method: string) => void;
  /** Keep the final response's raw body as `bytes` (a file), beside the text. */
  binary?: boolean;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1];
/** Hidden fields an IdP posts back to the service: SAML, OIDC/OAuth form_post, WS-Federation. */
const ASSERTION_FIELDS = ["SAMLResponse", "code", "id_token", "wresult"];

/** The IdP's auto-submitting form, if this page is one. */
export function autoPostForm(html: string, baseUrl: string): { action: string; body: string } | null {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const fields = new URLSearchParams();
    for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
      const name = attr(input[1], "name");
      if ((attr(input[1], "type") ?? "text").toLowerCase() === "hidden" && name) fields.append(name, decodeEntities(attr(input[1], "value") ?? ""));
    }
    if (!ASSERTION_FIELDS.some((f) => fields.has(f))) continue;
    if ((attr(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
    return { action: new URL(decodeEntities(attr(form[1], "action") ?? baseUrl), baseUrl).href, body: fields.toString() };
  }
  return null;
}

/** A bare redirect stub (a page with no content of its own that only sets location). */
export function redirectStub(html: string, baseUrl: string): string | null {
  const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, "").trim();
  if (visible.length > 200) return null;
  const m =
    /window\.location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/.exec(html) ||
    /window\.location\.replace\(\s*['"]([^'"]+)['"]/.exec(html) ||
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i.exec(html);
  return m ? new URL(decodeEntities(m[1]), baseUrl).href : null;
}

/**
 * Send a request through the sign-in dance and return the service's final response. A non-GET
 * request that was diverted through an IdP is sent once more after the dance, so its method and body
 * reach the service rather than the IdP. Throws SessionExpiredError when the dance ends on an IdP
 * sign-in page instead of the service.
 */
export async function sessionFetch(request: SessionRequest, opts: SessionFetchOptions): Promise<SessionResponse> {
  const impl = opts.fetchImpl ?? fetch;
  const maxHops = opts.maxHops ?? 16;
  const hopTimeoutMs = opts.hopTimeoutMs ?? 20_000;
  const trace: string[] = [];
  const origin = new URL(request.url);
  const callerHeaders = Object.fromEntries(Object.entries(request.headers ?? {}).filter(([k]) => k.toLowerCase() !== "cookie"));

  // True once an IdP intercepted the request: only then is a non-GET request sent again. A
  // request aimed at an IdP host itself is never resent.
  const toIdp = SIGN_IN_HOSTS.has(origin.hostname);
  let signedIn = false;
  const send = async (url: string, method: string, headers: Record<string, string>, body?: string) => {
    opts.guard?.(url, method);
    if (!toIdp && SIGN_IN_HOSTS.has(new URL(url).hostname)) signedIn = true;
    const cookie = opts.jar.headerFor(url);
    const signal = AbortSignal.timeout(hopTimeoutMs);
    const res = await impl(url, {
      method,
      body,
      redirect: "manual",
      signal,
      headers: { "user-agent": UA, ...headers, ...(cookie ? { cookie } : {}) },
    });
    opts.jar.absorb(url, typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : []);
    const here = new URL(url);
    trace.push(`${method === "GET" ? "" : method + " "}${res.status} ${here.host}${here.pathname}`);
    if (res.status >= 300 && res.status < 400) return { res, text: "", bytes: new Uint8Array() };
    // Read the body once as bytes so a file survives; the text is the same UTF-8 decoding res.text() does.
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { res, text: new TextDecoder().decode(bytes), bytes };
  };

  let url = request.url;
  let method = (request.method ?? "GET").toUpperCase();
  let headers = callerHeaders;
  let body = request.body;
  let danced = false;
  for (let hop = 0; hop <= maxHops; hop++) {
    const { res, text, bytes } = await send(url, method, headers, body);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return finish(res, text, url, bytes);
      const next = new URL(location, url);
      if (next.host !== origin.host) danced = true;
      url = next.href;
      if (res.status !== 307 && res.status !== 308) {
        method = "GET";
        body = undefined;
      }
      // Caller headers belong to the caller's request, not to the IdP's pages.
      if (danced) headers = {};
      continue;
    }
    const html = (res.headers.get("content-type") ?? "").includes("html") ? text : "";
    const post = html && autoPostForm(html, url);
    if (post) {
      danced = true;
      signedIn = !toIdp;
      url = post.action;
      method = "POST";
      body = post.body;
      headers = { "content-type": "application/x-www-form-urlencoded" };
      continue;
    }
    const stub = html && redirectStub(html, url);
    if (stub && stub !== url) {
      danced = true;
      url = stub;
      method = "GET";
      body = undefined;
      headers = {};
      continue;
    }
    const host = new URL(url).hostname;
    if (SIGN_IN_HOSTS.has(host) && !SIGN_IN_HOSTS.has(origin.hostname)) throw new SessionExpiredError(host);
    const original = (request.method ?? "GET").toUpperCase();
    if (signedIn && original !== "GET" && original !== "HEAD") {
      // The request was diverted to sign in: send the caller's own request once more, without
      // another dance. A request the service answered with a redirect elsewhere is not resent.
      const replay = await send(request.url, original, callerHeaders, request.body);
      return finish(replay.res, replay.text, request.url, replay.bytes);
    }
    return finish(res, text, url, bytes);
  }
  throw new Error(`sign-in dance exceeded ${maxHops} hops (last: ${new URL(url).host}${new URL(url).pathname})`);

  function finish(res: Response, text: string, url: string, bytes: Uint8Array): SessionResponse {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (name !== "set-cookie") headers[name] = value;
    });
    const out: SessionResponse = { status: res.status, url, contentType: res.headers.get("content-type") ?? "", headers, text, trace };
    if (opts.binary) out.bytes = bytes;
    return out;
  }
}
