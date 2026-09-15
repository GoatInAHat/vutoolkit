/**
 * Minimal cookie jar + redirect-following GET for the YES apps' OIDC dance: each SP bounces
 * through onevu (Okta) before answering, so a live fetch must carry cookies across hops.
 * Domain-scoped per RFC 6265 suffix rules; set-cookie is absorbed at every hop. Cookie values
 * live only inside the jar instance — nothing here logs, echoes, or serializes them.
 */
import type { CookieRecord } from "../vault/file-store.js";
import { assertSafe } from "./guard.js";

interface JarEntry {
  name: string;
  value: string;
  domain: string;
}

export class CookieJar {
  private readonly entries: JarEntry[];

  constructor(cookies: CookieRecord[] = []) {
    this.entries = cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: (c.domain ?? "").replace(/^\./, "").toLowerCase(),
    }));
  }

  /** Name=value pairs for this URL's domain scope; empty string when nothing applies. */
  headerFor(url: string): string {
    const host = new URL(url).hostname.toLowerCase();
    return this.entries
      .filter((c) => c.domain !== "" && (host === c.domain || host.endsWith("." + c.domain)))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  /** Merge set-cookie lines from a response; same name+domain overwrites. */
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

export interface JarFetchResult {
  status: number;
  contentType: string;
  text: string;
  finalUrl: string;
  /** One "302 host/path" line per hop — diagnostics without cookie values. */
  trace: string[];
}

export interface JarFetchOptions {
  jar: CookieJar;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  maxHops?: number;
}

/**
 * GET through the dance: manual redirect following with cookie absorption at every hop until a
 * final response. Every URL passes the YES write guard (GET reads only, structurally). Loops
 * past maxHops fail loudly instead of spinning.
 */
export async function jarFetch(url: string, opts: JarFetchOptions): Promise<JarFetchResult> {
  const impl = opts.fetchImpl ?? fetch;
  const maxHops = opts.maxHops ?? 12;
  let current = url;
  const trace: string[] = [];
  for (let hop = 0; hop <= maxHops; hop++) {
    assertSafe(current, "GET");
    const cookie = opts.jar.headerFor(current);
    const res = await impl(current, {
      redirect: "manual",
      headers: {
        "user-agent": "vutoolkit/0.1 (YES read-only client)",
        ...(opts.headers ?? {}),
        ...(cookie ? { cookie } : {}),
      },
    });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    opts.jar.absorb(current, setCookies);
    const here = new URL(current);
    trace.push(`${res.status} ${here.host}${here.pathname}`);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`YES dance: ${res.status} without location at ${here.host}${here.pathname}`);
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
  throw new Error(`YES dance exceeded ${maxHops} redirects (last: ${last.host}${last.pathname})`);
}
