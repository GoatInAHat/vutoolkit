/**
 * Brightspace client: read-only authenticated access to brightspace.vanderbilt.edu riding the
 * cached vanderbilt session. The D2L tenant sits behind OneVU (Okta) SAML: unauthenticated D2L
 * pages answer with JS-redirect stubs to /d2l/login, which 302s into the Okta SSO app, which
 * hands back a SAML POST binding for the Brightspace assertion consumer. The dance loop here
 * follows HTTP redirects, JS/meta redirects and submits that assertion POST once - the POST is
 * the IdP assertion hop, not a D2L mutation. Read-only stays structural: GET-only walk, entry
 * URL pinned to brightspace.vanderbilt.edu, cookies jar-scoped per RFC 6265. The YES
 * cart/enrollment guard does not govern this domain (its /enroll/i pattern false-positives on
 * D2L's read-only myenrollments route). Cookie and XSRF-token values never leave the vault or
 * this module; page text has scripts stripped so tokens cannot leak through output.
 */
import type { CookieRecord } from "../vault/file-store.js";
import { CookieJar } from "../yes/jar.js";

export const BRIGHTSPACE_ORIGIN = "https://brightspace.vanderbilt.edu";
const UA = "vutoolkit/0.1 (Brightspace read-only client)";

export class BrightspaceNotConfiguredError extends Error {}

export interface BrightspacePage {
  status: number;
  finalUrl: string;
  title: string;
  text: string;
  /** One line per dance hop - diagnostics without cookie values. */
  trace: string[];
}

export interface BrightspaceApiResult {
  status: number;
  contentType: string;
  text: string;
  finalUrl: string;
  trace: string[];
}

export interface WalkResult {
  status: number;
  contentType: string;
  text: string;
  finalUrl: string;
  trace: string[];
}

interface SamlAutoPost {
  action: string;
  fields: Record<string, string>;
}

const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
const INPUT_RE = /<input\b([^>]*)>/gi;

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return m ? m[1] : undefined;
};

/** Decode HTML entities in attribute values (Okta entity-encodes : and / in the SAML action). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** The SAML POST binding: an auto-submit form carrying SAMLResponse (+RelayState). */
export function samlAutoPost(html: string, baseUrl: string): SamlAutoPost | null {
  FORM_RE.lastIndex = 0;
  let form: RegExpExecArray | null;
  while ((form = FORM_RE.exec(html)) !== null) {
    const fields: Record<string, string> = {};
    INPUT_RE.lastIndex = 0;
    let input: RegExpExecArray | null;
    while ((input = INPUT_RE.exec(form[2])) !== null) {
      const type = (attr(input[1], "type") || "text").toLowerCase();
      const name = attr(input[1], "name");
      if (type === "hidden" && name) fields[name] = decodeEntities(attr(input[1], "value") ?? "");
    }
    if (fields.SAMLResponse !== undefined) {
      const action = attr(form[1], "action") || baseUrl;
      return { action: new URL(decodeEntities(action), baseUrl).href, fields };
    }
  }
  return null;
}

/** D2L answers unauthenticated pages with JS/meta redirect stubs (session-expiry bounce to /d2l/login). */
export function jsRedirect(html: string, baseUrl: string): string | null {
  const m =
    /window\.location(?:\.replace)?\s*=\s*['"]([^'"]+)['"]/.exec(html) ||
    /window\.location\.replace\(\s*['"]([^'"]+)['"]/.exec(html) ||
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i.exec(html);
  return m ? new URL(m[1], baseUrl).href : null;
}

/** D2L embeds the API CSRF token in page scripts; used internally for fetchApi, never emitted. */
export function xsrfToken(html: string): string | null {
  const m = /XSRF\.token\s*=\s*['"]([^'"]+)['"]/.exec(html);
  return m ? m[1] : null;
}

/** HTML to bounded readable text: scripts/styles/tags out, common entities decoded. */
export function stripHtml(html: string, maxChars: number): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, maxChars);
}

export function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripHtml(m[1], 200) : "";
}

/** Manual-redirect GET walk with cookie absorption at every hop (the jar scopes cookies per domain). */
export async function walk(
  url: string,
  jar: CookieJar,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {},
  maxHops = 12,
  hopTimeoutMs = 20_000,
): Promise<WalkResult> {
  let current = url;
  const trace: string[] = [];
  for (let hop = 0; hop <= maxHops; hop++) {
    const cookie = jar.headerFor(current);
    const signal = AbortSignal.timeout(hopTimeoutMs);
    const res = await fetchImpl(current, {
      redirect: "manual",
      signal,
      headers: { "user-agent": UA, accept: "text/html", ...headers, ...(cookie ? { cookie } : {}) },
    });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    jar.absorb(current, setCookies);
    const here = new URL(current);
    trace.push(`${res.status} ${here.host}${here.pathname}`);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`Brightspace dance: ${res.status} without location at ${here.host}${here.pathname}`);
      current = new URL(location, current).href;
      continue;
    }
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      text: await res.text(),
      finalUrl: current,
      trace,
    };
  }
  const last = new URL(current);
  throw new Error(`Brightspace dance exceeded ${maxHops} redirects (last: ${last.host}${last.pathname})`);
}

export interface BrightspaceFetchOptions {
  /** Stored vanderbilt session cookies (from the vault), scoped per-domain for the jar. */
  cookies?: CookieRecord[];
  fetchImpl?: typeof fetch;
}

interface Established {
  jar: CookieJar;
  impl: typeof fetch;
  status: number;
  html: string;
  finalUrl: string;
  token: string | null;
  trace: string[];
}

export class BrightspaceClient {
  constructor(private readonly opts: BrightspaceFetchOptions = {}) {}

  private configured(): CookieJar {
    if (!this.opts.cookies || this.opts.cookies.length === 0) {
      throw new BrightspaceNotConfiguredError(
        "live Brightspace access needs a vanderbilt session: pass cookies from the vault (the operation mints one automatically when the vault is empty)",
      );
    }
    return new CookieJar(this.opts.cookies);
  }

  private pinned(path: string): string {
    const url = new URL(path, BRIGHTSPACE_ORIGIN).href;
    if (!url.startsWith(BRIGHTSPACE_ORIGIN + "/") && url !== BRIGHTSPACE_ORIGIN) {
      throw new Error(`refused: ${path} does not stay on brightspace.vanderbilt.edu`);
    }
    return url;
  }

  /**
   * The full SSO dance from one entry path: HTTP redirects, JS/meta redirect stubs and one SAML
   * assertion POST, until a stable non-stub page. Establishes the D2L session cookies and
   * collects the page-embedded XSRF token for API use (kept internal).
   */
  private async establish(path: string): Promise<Established> {
    const jar = this.configured();
    const impl = this.opts.fetchImpl ?? fetch;
    const trace: string[] = [];
    let url = this.pinned(path);
    let status = 0;
    let html = "";
    let finalUrl = url;
    for (let hop = 0; hop < 14; hop++) {
      const w = await walk(url, jar, impl);
      trace.push(...w.trace);
      status = w.status;
      html = w.text;
      finalUrl = w.finalUrl;
      if (status !== 200) break;
      const post = samlAutoPost(html, finalUrl);
      if (post) {
        const done = await this.submitAssertion(post, jar, impl, trace);
        status = done.status;
        html = done.html;
        finalUrl = done.finalUrl;
        if (status !== 200) break;
        continue;
      }
      const js = jsRedirect(html, finalUrl);
      if (js) {
        url = js;
        continue;
      }
      break;
    }
    return { jar, impl, status, html, finalUrl, token: xsrfToken(html), trace };
  }

  /** Read one Brightspace page through the full dance; returns stripped bounded text (no tokens). */
  async fetchPage(path: string, maxChars = 8000): Promise<BrightspacePage> {
    const est = await this.establish(path);
    return {
      status: est.status,
      finalUrl: est.finalUrl,
      title: pageTitle(est.html),
      text: stripHtml(est.html, maxChars),
      trace: est.trace,
    };
  }

  /** Authenticated GET of a D2L JSON API route: establishes the session dance first, then GETs with the page-derived XSRF token. */
  async fetchApi(path: string, maxChars = 16000): Promise<BrightspaceApiResult> {
    const est = await this.establish("/d2l/home");
    if (est.status !== 200) {
      return { status: est.status, contentType: "text/html", text: stripHtml(est.html, 400), finalUrl: est.finalUrl, trace: est.trace };
    }
    const url = this.pinned(path);
    const headers: Record<string, string> = { accept: "application/json" };
    if (est.token) headers["X-Csrf-Token"] = est.token;
    const w = await walk(url, est.jar, est.impl, headers);
    return { status: w.status, contentType: w.contentType, text: w.text.slice(0, maxChars), finalUrl: w.finalUrl, trace: w.trace };
  }

  /** Submit one SAML assertion POST (IdP -> SP assertion consumer), then walk the remaining GET redirects. */
  private async submitAssertion(
    post: SamlAutoPost,
    jar: CookieJar,
    impl: typeof fetch,
    trace: string[],
  ): Promise<{ status: number; html: string; finalUrl: string }> {
    const body = new URLSearchParams(post.fields).toString();
    const signal = AbortSignal.timeout(20_000);
    const res = await impl(post.action, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: {
        "user-agent": UA,
        "content-type": "application/x-www-form-urlencoded",
        ...(jar.headerFor(post.action) ? { cookie: jar.headerFor(post.action) } : {}),
      },
      body,
    });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    jar.absorb(post.action, setCookies);
    const here = new URL(post.action);
    trace.push(`POST ${res.status} ${here.host}${here.pathname}`);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      const walked = await walk(new URL(location ?? "/", post.action).href, jar, impl);
      trace.push(...walked.trace);
      return { status: walked.status, html: walked.text, finalUrl: walked.finalUrl };
    }
    return { status: res.status, html: await res.text(), finalUrl: post.action };
  }
}

