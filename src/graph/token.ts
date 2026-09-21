/**
 * The sso-to-graph chain (build order step 2, live-proven 2026-09-21): the vaulted Microsoft
 * session's Entra cookies (ESTSAUTHPERSISTENT & co on login.microsoftonline.com) buy a silent
 * OAuth authorization code from a first-party public client - no secret, no consent screen,
 * no browser, exactly one 302 in the common case - which exchanges for a Graph access token
 * good for about an hour.
 *
 * Tokens are cached in a 0600 JSON file next to the session vault and re-minted silently when
 * they run low; concurrent callers share one mint (single flight per cache file). Token values
 * never appear in logs, errors, or tool output - the same discipline as cookie material.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AuthError } from "../sso/errors.js";
import type { CookieRecord } from "../vault/file-store.js";

/** Microsoft Office: a first-party public client, pre-consented tenant-wide; no secret needed. */
const CLIENT_ID = "d3590ed6-52b3-4102-aeff-aad2292ab01c";
const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/token";
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
/** A cached token with less than this left is re-minted, not used. */
const MIN_VALIDITY_MS = 120_000;
const MAX_HOPS = 8;

interface JarEntry {
  name: string;
  value: string;
  domain: string;
}

/** Domain-suffix cookie scoping (RFC 6265), enough for the authorize dance; values stay in memory. */
class MintJar {
  private readonly entries: JarEntry[];

  constructor(cookies: CookieRecord[]) {
    this.entries = cookies
      .filter((c) => typeof c.domain === "string" && c.domain !== "")
      .map((c) => ({ name: c.name, value: c.value, domain: (c.domain ?? "").replace(/^\./, "").toLowerCase() }));
  }

  headerFor(url: string): string {
    const host = new URL(url).hostname.toLowerCase();
    return this.entries
      .filter((c) => host === c.domain || host.endsWith("." + c.domain))
      .map((c) => c.name + "=" + c.value)
      .join("; ");
  }

  absorb(url: string, setCookies: readonly string[]): void {
    const host = new URL(url).hostname.toLowerCase();
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      let domain = host;
      for (const attr of attrs) {
        const [k, v] = attr.split("=");
        if (k.trim().toLowerCase() === "domain" && v) domain = v.trim().replace(/^\./, "").toLowerCase();
      }
      const entry: JarEntry = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain };
      const i = this.entries.findIndex((c) => c.name === entry.name && c.domain === domain);
      if (i >= 0) this.entries[i] = entry;
      else this.entries.push(entry);
    }
  }
}

interface CachedToken {
  accessToken: string;
  acquiredAtMs: number;
  expiresAtMs: number;
}

/** The on-disk token cache: one 0600 JSON file, atomic writes, corrupt reads as empty. */
export class GraphTokenCache {
  constructor(private readonly filePath: string) {}

  get location(): string {
    return this.filePath;
  }

  read(): CachedToken | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<CachedToken>;
      if (
        typeof parsed.accessToken === "string" &&
        parsed.accessToken !== "" &&
        typeof parsed.acquiredAtMs === "number" &&
        typeof parsed.expiresAtMs === "number"
      ) {
        return { accessToken: parsed.accessToken, acquiredAtMs: parsed.acquiredAtMs, expiresAtMs: parsed.expiresAtMs };
      }
    } catch {
      /* fall through to empty */
    }
    return null;
  }

  put(token: CachedToken): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = this.filePath + "." + process.pid + ".tmp";
    writeFileSync(temp, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      /* best-effort on filesystems without chmod */
    }
    renameSync(temp, this.filePath);
  }
}

export type AuthorizeOutcome =
  | { kind: "code"; code: string }
  | { kind: "refused"; error: string }
  | { kind: "unexpected"; status: number; finalUrl: string };

/**
 * Pure verdict over the silent-authorize result, exported for tests. The happy path is a 302
 * straight at the redirect URI with the code in the query; some sessions answer 200 with an
 * auto-submitting form_post instead. prompt=none plus a tired session answers with an OAuth
 * error on the redirect URI - that is a refusal, not a parse failure.
 */
export function classifyAuthorize(
  status: number,
  finalUrl: string,
  location: string | null,
  body: string,
): AuthorizeOutcome {
  if (location && location.startsWith(REDIRECT_URI)) {
    const params = new URL(location).searchParams;
    const code = params.get("code");
    if (code) return { kind: "code", code };
    const error = params.get("error");
    if (error) return { kind: "refused", error };
  }
  if (status === 200) {
    const formCode = /name="code"[^>]*value="([^"]+)"/i.exec(body)?.[1] ?? /name="code"\s+value="([^"]+)"/i.exec(body)?.[1];
    if (formCode) return { kind: "code", code: formCode };
    if (/name="loginfmt"|"urlPost"/.test(body)) return { kind: "refused", error: "login page" };
  }
  return { kind: "unexpected", status, finalUrl };
}

export interface GraphTokenDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  loginHint?: string;
  /** Skip the cache check and mint anyway (a 401 from Graph means the token died early). */
  force?: boolean;
}

export interface GraphToken {
  accessToken: string;
  expiresAtMs: number;
  source: "cache" | "minted";
}

/** One mint at a time per cache file: parallel calls share a single authorize round-trip. */
const inflight = new Map<string, Promise<GraphToken>>();

export async function ensureGraphToken(
  cookies: CookieRecord[],
  cache: GraphTokenCache,
  deps: GraphTokenDeps = {},
): Promise<GraphToken> {
  const now = deps.now ?? Date.now;
  if (!deps.force) {
    const cached = cache.read();
    if (cached && cached.expiresAtMs - now() > MIN_VALIDITY_MS) {
      return { accessToken: cached.accessToken, expiresAtMs: cached.expiresAtMs, source: "cache" };
    }
  }
  const existing = inflight.get(cache.location);
  if (existing) return existing;
  const run = mintGraphToken(cookies, cache, deps).finally(() => inflight.delete(cache.location));
  inflight.set(cache.location, run);
  return run;
}

async function mintGraphToken(cookies: CookieRecord[], cache: GraphTokenCache, deps: GraphTokenDeps): Promise<GraphToken> {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const jar = new MintJar(cookies);
  const params: Record<string, string> = {
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    resource: "https://graph.microsoft.com",
    prompt: "none",
  };
  if (deps.loginHint) params.login_hint = deps.loginHint;
  let url = AUTHORIZE_URL + "?" + new URLSearchParams(params).toString();

  const trace = (line: string): void => {
    if (process.env.VUTOOLKIT_DEBUG) process.stderr.write("vutoolkit graph token: " + line + "\n");
  };
  let outcome: AuthorizeOutcome | null = null;
  for (let hop = 0; hop < MAX_HOPS && outcome === null; hop++) {
    const res = await fetchImpl(url, {
      redirect: "manual",
      headers: { "user-agent": BROWSER_UA, cookie: jar.headerFor(url) },
    });
    jar.absorb(url, res.headers.getSetCookie?.() ?? []);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url).toString();
      if (next.startsWith(REDIRECT_URI)) {
        outcome = classifyAuthorize(res.status, next, location, "");
        break;
      }
      url = next;
      continue;
    }
    outcome = classifyAuthorize(res.status, url, location, await res.text());
  }
  if (outcome === null) {
    throw new AuthError("GRAPH_TOKEN_UNAVAILABLE", "the silent Graph authorize exceeded " + MAX_HOPS + " redirects", {
      retryable: true,
    });
  }
  trace("authorize " + outcome.kind + (outcome.kind === "code" ? " (" + outcome.code.length + " chars)" : ""));
  if (outcome.kind === "refused") {
    throw new AuthError(
      "GRAPH_TOKEN_UNAVAILABLE",
      "the vaulted Microsoft session could not silently authorize Graph (" +
        outcome.error +
        "); run sessions.refresh for idp microsoft and retry",
      { retryable: true },
    );
  }
  if (outcome.kind === "unexpected") {
    throw new AuthError(
      "GRAPH_TOKEN_UNAVAILABLE",
      "the silent Graph authorize answered unexpectedly (HTTP " + outcome.status + " on " + safeHost(outcome.finalUrl) + ")",
      { retryable: true },
    );
  }

  const exchange = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": BROWSER_UA },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: outcome.code,
      resource: "https://graph.microsoft.com",
      redirect_uri: REDIRECT_URI,
    }),
  });
  const json = (await exchange.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number | string; error?: string; error_description?: string }
    | null;
  const expiresIn = json ? Number(json.expires_in) : Number.NaN;
  if (!json?.access_token || !Number.isFinite(expiresIn)) {
    trace("exchange status " + exchange.status + " keys " + (json ? Object.keys(json).join(",") : "unparseable"));
    throw new AuthError(
      "GRAPH_TOKEN_UNAVAILABLE",
      "the Graph token exchange failed (" +
        (json?.error ?? "HTTP " + exchange.status) +
        (json?.error_description ? ": " + json.error_description.slice(0, 120) : "") +
        "); run sessions.refresh for idp microsoft and retry",
      { retryable: true },
    );
  }
  const token: CachedToken = {
    accessToken: json.access_token,
    acquiredAtMs: now(),
    expiresAtMs: now() + expiresIn * 1000,
  };
  cache.put(token);
  return { accessToken: token.accessToken, expiresAtMs: token.expiresAtMs, source: "minted" };
}

/** Hostname for diagnostics; never carries query or cookie material. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unreadable URL";
  }
}
