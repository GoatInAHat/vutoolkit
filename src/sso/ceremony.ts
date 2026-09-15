/**
 * The OneVU SSO ceremony, ported from the live-proven reference (credentials/vutoolkit-live,
 * 2026-09-15 sweep): CDP virtual authenticator holds the vaulted passkey, the identifier is the
 * EMAIL, the Okta webauthn inner button is clicked, and success is /app/UserHome. Runs in its
 * own browser tab (created and closed here) so a shared managed browser is never disturbed.
 *
 * I/O honesty: this module speaks CDP over the network and returns the minted session in
 * memory. It never logs, writes, or echoes cookie or key material; errors carry no values.
 */
import type { CookieRecord } from "../vault/file-store.js";

/** The passkey as the vault stores it: raw base64url-ish fields, not the v1 JWK envelope. */
export interface VaultPasskey {
  credentialId: string;
  privateKey: string;
  userHandle: string;
  rpId: string;
  signCount: number;
}

export interface CeremonyOptions {
  /** CDP HTTP endpoint of the browser to drive, e.g. http://127.0.0.1:18800. */
  cdpUrl: string;
  /** Login identifier — the EMAIL, not the VUnetID (Okta rejects the display name). */
  email: string;
  passkey: VaultPasskey;
  loginUrl?: string;
  stepMs?: number;
}

export interface MintedSession {
  /** Every cookie the browser held at success, unscoped; the caller scopes per IdP. */
  cookies: Array<CookieRecord & { domain: string }>;
  acquiredAt: string;
  expiresAt?: string;
  finalUrl: string;
  signCountUsed: number;
}

/** base64url/base64 to padded base64, exactly as CDP addCredential expects. */
export function toCdpB64(value: string): string {
  let s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return s;
}

/** The proven success signal: OneVU post-login home, not the /enduser profile page. */
export function isLoginSuccess(url: string): boolean {
  if (/onevu\.vanderbilt\.edu\/app\/UserHome/.test(url)) return true;
  // A service-provider redirect that has left onevu entirely also means the SSO cleared —
  // but only to a real page: Chrome error pages and interstitials are not success.
  if (!/^https:\/\//.test(url)) return false;
  if (/chrome-error|about:blank|authorize|callback/.test(url)) return false;
  return !/onevu\.vanderbilt\.edu/.test(url);
}

const FILL_NATIVE = "(sel,val)=>{const el=document.querySelector(sel);if(!el)return false;" +
  "const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');d.set.call(el,val);" +
  "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}";
const CLICK_VISIBLE = "(s=>{const e=document.querySelector(s);if(!e||!(e.offsetParent||e.getClientRects().length))return false;e.click();return true;})";

export async function runSsoCeremony(opts: CeremonyOptions): Promise<MintedSession> {
  const stepMs = opts.stepMs ?? 2000;
  const loginUrl = opts.loginUrl ?? "https://onevu.vanderbilt.edu/";
  // The reference sweep found gateway proxy env breaks loopback CDP fetches. Bypass only for
  // loopback via NO_PROXY — external egress keeps its proxy; nothing in the environment is lost.
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const current = process.env[key] ?? "";
    if (!/(^|,)(127\.0\.0\.1|localhost)(,|$)/.test(current)) {
      process.env[key] = current ? `${current},127.0.0.1,localhost` : "127.0.0.1,localhost";
    }
  }
  const listRes = await fetch(new URL("/json/list", opts.cdpUrl));
  const tabs = (await listRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
  const blank = await fetch(new URL("/json/new?about:blank", opts.cdpUrl), { method: "PUT" });
  if (!blank.ok) throw new Error(`ceremony could not open a tab (HTTP ${blank.status})`);
  const tab = (await blank.json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ceremony CDP websocket failed")); });
  let mid = 0;
  const pending = new Map<number, (m: { id?: number; error?: unknown; result?: unknown }) => void>();
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; result?: unknown };
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    } catch { /* non-JSON frames are events; ignored */ }
  };
  const send = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise((res, rej) => {
      const id = ++mid;
      pending.set(id, (m) => m.error
        ? rej(new Error(`ceremony: ${method} failed`))
        : res(m.result as T));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string): Promise<unknown> => {
    const r = await send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.value;
  };
  try {
    await send("Page.enable");
    await send("WebAuthn.enable");
    const au = await send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    const signCountUsed = (Number(opts.passkey.signCount) || 0) + 1;
    await send("WebAuthn.addCredential", {
      authenticatorId: au.authenticatorId,
      credential: {
        credentialId: toCdpB64(opts.passkey.credentialId),
        isResidentCredential: false,
        rpId: opts.passkey.rpId,
        privateKey: toCdpB64(opts.passkey.privateKey),
        userHandle: toCdpB64(opts.passkey.userHandle),
        signCount: signCountUsed,
      },
    });
    await send("Page.navigate", { url: loginUrl });
    await new Promise((r) => setTimeout(r, 9000));
    // Graceful path: a persistent browser profile may already hold a live session, in which
    // case the login page never renders and we go straight to harvesting cookies.
    let finalUrl = String((await evaluate("location.href")) ?? "");
    let success = isLoginSuccess(finalUrl);
    if (!success) {
      const filled = await evaluate(`(${FILL_NATIVE})('input[name=identifier]', ${JSON.stringify(opts.email)})`);
      if (filled !== true) throw new Error("ceremony: identifier field not found on the login page");
      const submitted = await evaluate(`(${CLICK_VISIBLE})('input[type=submit],button[type=submit]')`);
      if (submitted !== true) throw new Error("ceremony: submit control not found");
      await new Promise((r) => setTimeout(r, 5000));
      let chooser = false;
      for (let i = 0; i < 6 && !chooser; i++) {
        chooser = (await evaluate(`(${CLICK_VISIBLE})('[data-se=webauthn] [data-se=button]')`)) === true;
        if (!chooser) await new Promise((r) => setTimeout(r, stepMs));
      }
      if (!chooser) throw new Error("ceremony: webauthn authenticator option never appeared");
      for (let i = 0; i < 20 && !success; i++) {
        await new Promise((r) => setTimeout(r, stepMs));
        try {
          finalUrl = String((await evaluate("location.href")) ?? "");
          success = isLoginSuccess(finalUrl);
        } catch { /* transient evaluate failures during navigation are fine */ }
      }
    }
    if (!success) throw new Error(`ceremony: login did not reach OneVU home (ended on ${new URL(finalUrl || "about:blank").pathname})`);
    const storage = await send<{ cookies: Array<Record<string, unknown>> }>("Storage.getCookies", {});
    const cookies = storage.cookies.map((c) => ({
      name: String(c.name),
      value: String(c.value),
      domain: String(c.domain ?? ""),
      path: typeof c.path === "string" ? c.path : undefined,
      expires: typeof c.expires === "number" ? c.expires : undefined,
      httpOnly: typeof c.httpOnly === "boolean" ? c.httpOnly : undefined,
      secure: typeof c.secure === "boolean" ? c.secure : undefined,
      sameSite: typeof c.sameSite === "string" ? c.sameSite : undefined,
    })) as Array<CookieRecord & { domain: string }>;
    const expiries = cookies.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
    return {
      cookies,
      acquiredAt: new Date().toISOString(),
      expiresAt: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : undefined,
      finalUrl,
      signCountUsed,
    };
  } finally {
    ws.close();
    try { await fetch(new URL(`/json/close/${tab.id}`, opts.cdpUrl)); } catch { /* tab cleanup best-effort */ }
  }
}
