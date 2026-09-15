/**
 * The OneVU SSO ceremony, ported from the live-proven reference (credentials/vutoolkit-live,
 * 2026-09-15 sweep): CDP virtual authenticator holds the vaulted passkey, the identifier is the
 * EMAIL, the Okta webauthn inner button is clicked, and success is /app/UserHome. Runs in its
 * own browser tab (created and closed by the shared driver) so a shared managed browser is
 * never disturbed.
 *
 * I/O honesty: this module speaks CDP over the network and returns the minted session in
 * memory. It never logs, writes, or echoes cookie or key material; errors carry no values.
 */
import type { CookieRecord } from "../vault/file-store.js";
import { CLICK_VISIBLE, FILL_NATIVE, harvestCookies, withCdpTab } from "./cdp-driver.js";

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

export async function runSsoCeremony(opts: CeremonyOptions): Promise<MintedSession> {
  const stepMs = opts.stepMs ?? 2000;
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
    // The driver created the tab on the login URL; give the page a first beat, then drive.
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
    const cookies = await harvestCookies(send);
    const expiries = cookies.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
    return {
      cookies,
      acquiredAt: new Date().toISOString(),
      expiresAt: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : undefined,
      finalUrl,
      signCountUsed,
    };
  });
}
