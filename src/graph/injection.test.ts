/**
 * The injection chain, proved at the operation boundary (graph.call): what a downstream consumer
 * actually gets is whatever `vaultStore` holds. graph.call must (1) run sessions.ensure for
 * microsoft before minting — so a cached row in its probe window is used as-is, a dead row is
 * probed and replaced rather than handed on, and a failed re-mint preserves the row — and
 * (2) mint the Graph token from the STORE's cookies, then re-mint on a 401. These tests drive the
 * real handlers with a temp data dir and stub only the network (global fetch) and the one host
 * process the ensure path shells out to (the browser-status CLI), so vault → ensure → token →
 * Graph runs for real.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { harvestToStoredSession, sessionStore, type FileSessionStore } from "../vault/file-store.js";
import { operations } from "../ops.js";
import { cdpReachable } from "../sso/cdp-driver.js";
import { probeSession } from "../sso/liveness.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // resolveBrowser asks the host for its selected browser; answer with the test's own endpoint.
  // It calls promisify(execFile), and promisify passes (file, args, options, callback) — four
  // arguments, not three. Answering through the same promisify.custom symbol ensure.test.ts uses
  // keeps the fixture honest about the real call shape instead of guessing the callback position.
  const status = vi.fn(async () => ({
    stdout: JSON.stringify({ enabled: true, driver: "openclaw", profile: "test", cdpUrl: TEST_CDP_URL, attachOnly: true }),
    stderr: "",
  }));
  const execFile = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: status });
  return { ...actual, execFile, execFileSync: vi.fn() };
});
// Pin the endpoint check: the fixture browser is attach-only on a port with no listener, and a
// real cdpReachable would pay a TCP-connect timeout. No test here drives a real browser.
vi.mock("../sso/cdp-driver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sso/cdp-driver.js")>();
  return { ...actual, cdpReachable: vi.fn(async () => false) };
});

const TEST_CDP_URL = "http://127.0.0.1:18999";

const dirs: string[] = [];
const freshDir = () => { const dir = mkdtempSync(join(tmpdir(), "vutoolkit-inject-")); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const GRAPH_ME = "https://graph.microsoft.com/v1.0/me";
// probeMicrosoft builds this URL as a literal string (src/sso/liveness.ts): "$select" is not
// percent-encoded, so the fixture must match the literal spelling, not "%24select".
const GRAPH_ME_SELECT = "https://graph.microsoft.com/v1.0/me?$select=id";
const MINTED = "synthetic-graph-token";
/** The production redirect URI (token.ts REDIRECT_URI); the authorize verdict is keyed to it. */
const OAUTH_REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient";

interface NetworkOptions {
  /** Cookies the silent authorize accepts; anything else is refused as interaction_required. */
  acceptCookie: string;
}

function stubNetwork(options: NetworkOptions) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let mintedTokenIssued = false;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = { ...(init?.headers as Record<string, string>) };
    requests.push({ url, headers });
    if (url === GRAPH_ME || url === GRAPH_ME_SELECT) {
      // The token is only ever minted from the authorize code; a refused authorize means no token,
      // so this read-only probe must answer 401 (never a fixture id for an absent bearer).
      const auth = headers.authorization ?? "";
      return auth === `Bearer ${MINTED}` && mintedTokenIssued
        ? new Response(JSON.stringify({ id: "synthetic-user" }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }), { status: 401 });
    }
    if (url.includes("login.microsoftonline.com") && url.includes("authorize")) {
      const cookie = headers.cookie ?? "";
      const accepted = cookie.includes(`ESTSAUTHPERSISTENT=${options.acceptCookie}`);
      if (!accepted) {
        return new Response(null, {
          status: 302,
          headers: { location: OAUTH_REDIRECT + "?error=interaction_required" },
        });
      }
      return new Response(null, { status: 302, headers: { location: OAUTH_REDIRECT + "?code=synthetic-code" } });
    }
    if (url.includes("login.microsoftonline.com") && url.includes("token")) {
      // Honest token exchange: only an authorize-issued code buys the fixture token.
      const body = String(init?.body ?? "");
      if (!body.includes("code=synthetic-code")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      mintedTokenIssued = true;
      return new Response(JSON.stringify({ access_token: MINTED, expires_in: 3600 }), { status: 200 });
    }
    return new Response("unexpected " + url, { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return requests;
}

const op = (name: string) => operations.find((o) => o.name === name)!;
const ctx = (dataDir: string) => ({ dataDir, config: {} });
const microsoftSession = (cookieValue: string) =>
  harvestToStoredSession(
    "microsoft",
    [{ name: "ESTSAUTHPERSISTENT", value: cookieValue, domain: "login.microsoftonline.com" }],
    "2026-09-15T12:00:00.000Z",
  );
const justAcquired = () => new Date().toISOString();
const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();

describe("graph.call injection chain", () => {
  beforeEach(() => vi.stubEnv("VUTOOLKIT_CREDENTIAL_STORE", "file"));

  it("sends a read-only GET through the stored Microsoft session's minted token", async () => {
    const dataDir = freshDir();
    // Acquired now, so ensure skips the probe: this isolates the token-injection step.
    const store = sessionStore(dataDir);
    await store.put({ ...microsoftSession("live-cookie"), acquiredAt: justAcquired(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const requests = stubNetwork({ acceptCookie: "live-cookie" });

    const result = await op("graph.call").handler({ method: "GET", path: "/me" } as never, ctx(dataDir));

    expect(result).toEqual({ status: 200, data: { id: "synthetic-user" } });
    const authorize = requests.find((r) => r.url.includes("authorize"))!;
    // The injection is real: the authorize hop was offered the vaulted session's cookie.
    expect(authorize.headers.cookie).toContain("ESTSAUTHPERSISTENT=live-cookie");
    expect(requests.find((r) => r.url === GRAPH_ME)!.headers.authorization).toBe(`Bearer ${MINTED}`);
    // The operation result never carries token or cookie material.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(MINTED);
    expect(serialized).not.toContain("live-cookie");
  });

  // Budget: the probe and the Entra carry's attach-only endpoint check (both mocked to answer
  // immediately) plus ensure's single retry wait. The retry is real and adds 3s; allow for it
  // explicitly rather than raising the global timeout. BROWSER_UNAVAILABLE is non-retryable, so
  // no retry wait is paid here in practice — the budget is headroom, not a required expense.
  //
  // A session with cookies probes through the token mint first (probeMicrosoft -> ensureGraphToken),
  // and a refused silent authorize fails before any Graph call; that refusal is already covered
  // in token.test.ts. Here the stored cookies are empty (a row that carries only a pre-scoped
  // header), so probeSession answers false without a network call — the liveness decision is the
  // real one — and ensure must never hand the dead row to the injection chain.
  it("probes a dead-but-unexpired session, fails closed, and never publishes or uses the dead cookie", async () => {
    // The mocked cdpReachable (module-level) answers false immediately, so ensure fails fast
    // rather than waiting on a host TCP timeout for the (absent) test CDP endpoint.
    expect(await cdpReachable(TEST_CDP_URL)).toBe(false);
    const dataDir = freshDir();
    const store: FileSessionStore = sessionStore(dataDir);
    // Outside the 2-minute probe-skip window with far-future expiry: ensure must probe it.
    const deadAcquiredAt = hourAgo();
    await store.put({ cookieHeader: "ESTSAUTHPERSISTENT=dead-cookie", idp: "microsoft", acquiredAt: deadAcquiredAt,
      expiresAt: "2099-01-01T00:00:00.000Z", healthy: true, cookies: [] });
    // The probe decision is the real one: the stored row has no cookie records, so the liveness
    // probe answers false (this is the exact value ensure acts on).
    expect(await probeSession("microsoft", store.cookies("microsoft"))).toBe(false);
    // The fixture browser is attach-only and unreachable, so no browser can mint: ensure makes
    // one attempt (+ one retry) and fails with a typed, non-retryable error.
    const requests = stubNetwork({ acceptCookie: "nobody" });

    await expect(
      op("graph.call").handler({ method: "GET", path: "/me" } as never, ctx(dataDir)),
    ).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });

    // The injection chain never minted for a dead session: no Graph read, no OAuth authorize.
    expect(requests).toHaveLength(0);
    expect(requests.filter((r) => r.url === GRAPH_ME)).toHaveLength(0);
    // ensure replaces only after a successful mint: the failed call preserved the row untouched.
    expect((await store.get("microsoft"))?.cookieHeader).toBe("ESTSAUTHPERSISTENT=dead-cookie");
    expect((await store.get("microsoft"))?.acquiredAt).toBe(deadAcquiredAt);
  }, 20_000);

  it("re-mints the Graph token once when Graph answers 401 to a valid session", async () => {
    const dataDir = freshDir();
    const store = sessionStore(dataDir);
    await store.put({ ...microsoftSession("live-cookie"), acquiredAt: justAcquired(), expiresAt: "2099-01-01T00:00:00.000Z" });
    const requests = stubNetwork({ acceptCookie: "live-cookie" });
    // First /me answers 401 to a fresh token; the second (force) token succeeds.
    let graphCalls = 0;
    const inner = globalThis.fetch;
    // input is the fetch signature's own type, not `unknown`: this stub forwards it to the real
    // fetch unchanged, so retyping it keeps the passthrough honest rather than casting it away.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === GRAPH_ME && graphCalls++ === 0) {
        requests.push({ url: GRAPH_ME, headers: { ...(init?.headers as Record<string, string>) } });
        return new Response(JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }), { status: 401 });
      }
      return inner(input, init);
    }));

    const result = await op("graph.call").handler({ method: "GET", path: "/me" } as never, ctx(dataDir));
    expect(result).toEqual({ status: 200, data: { id: "synthetic-user" } });
    expect(requests.filter((r) => r.url === GRAPH_ME)).toHaveLength(2);
    // The session itself is unchanged: a token 401 does not burn the stored cookies.
    expect((await store.get("microsoft"))?.cookieHeader).toBe("ESTSAUTHPERSISTENT=live-cookie");
  });

  it("refuses to leave the pinned v1.0 root before touching the session or network", async () => {
    const dataDir = freshDir();
    await sessionStore(dataDir).put({ ...microsoftSession("live-cookie"), acquiredAt: justAcquired() });
    const requests = stubNetwork({ acceptCookie: "live-cookie" });
    await expect(
      op("graph.call").handler({ method: "GET", path: "/%2e%2e/beta/me" } as never, ctx(dataDir)),
    ).rejects.toThrow(TypeError);
    expect(requests).toHaveLength(0);
  });
});
