/**
 * The OneVU SSO ceremony, ported from the live-proven reference (credentials/vutoolkit-live,
 * 2026-09-15 sweep): CDP virtual authenticator holds the vaulted passkey, the identifier is the
 * EMAIL, the Okta webauthn inner button is clicked, and success is /app/UserHome. Runs in its
 * own browser tab (created and closed by the shared driver) so a shared managed browser is
 * never disturbed.
 *
 * The flow is a polling state machine with a deadline rather than a fixed script: the page is
 * probed every step and the ceremony acts on what is actually rendered. That covers the
 * already-signed-in profile, an Okta that skips the identifier because it remembers the user,
 * slow page loads, and a re-rendered identifier form, and it fails with Okta's own error text
 * instead of a timeout when OneVU rejects the attempt.
 *
 * I/O honesty: this module speaks CDP over the network and returns the minted session in
 * memory. It never logs, writes, or echoes cookie or key material; errors carry no values.
 */
import type { CookieRecord } from "../vault/file-store.js";
import { CLICK_VISIBLE, FILL_NATIVE, harvestCookies, withCdpTab } from "./cdp-driver.js";
import { AuthError } from "./errors.js";

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
  /** Whole-ceremony deadline; defaults to 120 seconds. */
  timeoutMs?: number;
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

/** One observation of the OneVU page. */
export interface OktaProbe {
  url: string;
  /** The identifier (email) input is rendered. */
  identifier: boolean;
  /** The webauthn authenticator's Select button is rendered. */
  webauthn: boolean;
  /** Okta's form error text, empty when none is shown. */
  error: string;
}

export type OktaFlowState =
  | { kind: "success" }
  | { kind: "error"; message: string }
  | { kind: "webauthn" }
  | { kind: "identifier" }
  | { kind: "wait" };

/** Pure state machine over one probe; the ceremony only acts on it. */
export function classifyOktaFlow(probe: OktaProbe): OktaFlowState {
  if (isLoginSuccess(probe.url)) return { kind: "success" };
  if (probe.error) return { kind: "error", message: probe.error };
  if (probe.webauthn) return { kind: "webauthn" };
  if (probe.identifier) return { kind: "identifier" };
  return { kind: "wait" };
}

const PROBE_EXPR =
  "(() => {" +
  " const vis = (s) => { const e = document.querySelector(s); return !!(e && (e.offsetParent || e.getClientRects().length)); };" +
  " const errEl = document.querySelector('.o-form-error-container');" +
  " const error = errEl ? (errEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : '';" +
  " return { url: location.href, identifier: vis('input[name=identifier]'), webauthn: vis('[data-se=webauthn] [data-se=button]'), error };" +
  "})()";

/** Tick Okta's "Keep me signed in" when it is offered, so the Okta session survives browser restarts. */
const KEEP_SIGNED_IN =
  "(() => { const box = document.querySelector('input[name=rememberMe]');" +
  " if (!box || box.checked) return false; box.click(); return box.checked; })()";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSsoCeremony(opts: CeremonyOptions): Promise<MintedSession> {
  const stepMs = opts.stepMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const loginUrl = opts.loginUrl ?? "https://onevu.vanderbilt.edu/";
  return withCdpTab(opts.cdpUrl, loginUrl, async (tab) => {
    const { send, evaluate } = tab;
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

    const deadline = Date.now() + timeoutMs;
    let finalUrl = "";
    let identifierSubmits = 0;
    let webauthnClicks = 0;
    let first = true;
    while (Date.now() < deadline) {
      await sleep(first ? 2500 : stepMs);
      first = false;
      const probe = (await evaluate(PROBE_EXPR).catch(() => null)) as OktaProbe | null;
      if (!probe) continue; // mid-navigation; probe again
      finalUrl = String(probe.url ?? "");
      const state = classifyOktaFlow(probe);
      if (state.kind === "success") {
        const cookies = await harvestCookies(send);
        const expiries = cookies.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
        return {
          cookies,
          acquiredAt: new Date().toISOString(),
          expiresAt: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : undefined,
          finalUrl,
          signCountUsed,
        };
      }
      if (state.kind === "error") {
        throw new AuthError("OKTA_REJECTED", `OneVU sign-in showed an error: "${state.message}"`, { retryable: true });
      }
      if (state.kind === "webauthn" && webauthnClicks < 3) {
        if ((await evaluate(`(${CLICK_VISIBLE})('[data-se=webauthn] [data-se=button]')`).catch(() => false)) === true) webauthnClicks++;
        continue;
      }
      if (state.kind === "identifier" && identifierSubmits < 2) {
        const filled = await evaluate(`(${FILL_NATIVE})('input[name=identifier]', ${JSON.stringify(opts.email)})`).catch(() => false);
        if (filled !== true) continue;
        await evaluate(KEEP_SIGNED_IN).catch(() => false);
        if ((await evaluate(`(${CLICK_VISIBLE})('input[type=submit],button[type=submit]')`).catch(() => false)) === true) identifierSubmits++;
      }
    }
    let where = "an unknown page";
    try {
      const u = new URL(finalUrl);
      where = u.host + u.pathname;
    } catch { /* keep default */ }
    throw new AuthError(
      "OKTA_FLOW_CHANGED",
      `OneVU sign-in did not reach the OneVU home within ${Math.round(timeoutMs / 1000)}s (last page ${where}; identifier submits ${identifierSubmits}, passkey selections ${webauthnClicks})`,
      { retryable: true },
    );
  });
}
