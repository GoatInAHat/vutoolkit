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
  isResidentCredential?: boolean;
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
  /** Prove this key signs in from an empty, disposable browser context. */
  requireAssertion?: boolean;
  signal?: AbortSignal;
  /** Runs before authenticator removal on every exit, including failed harvests/restarts. */
  accountCounter?: (count: number) => Promise<void>;

}

export interface MintedSession {
  /** Every cookie the browser held at success, unscoped; the caller scopes per IdP. */
  cookies: Array<CookieRecord & { domain: string }>;
  acquiredAt: string;
  expiresAt?: string;
  finalUrl: string;
  signCountUsed: number;
  /** True only after an isolated assertion and exact OneVU home redirect. */
  passkeyVerified?: boolean;
  /** Observed counter after the verified assertion, for vault persistence. */
  assertedSignCount?: number;
}

/** Uncertain accounting is not a retryable sign-in failure. The owner must fail closed. */
export class CounterAccountingError extends AuthError {
  constructor(cause: unknown) {
    super("VAULT_SECRET_UNAVAILABLE", "Passkey counter accounting could not be verified; this flight is quarantined until operator reconciliation.", { retryable: false, cause });
  }
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
  /** Automatic WebAuthn verification is pending; this screen need not have a Verify button. */
  verifying?: boolean;
  /** Okta's form error text, empty when none is shown. */
  error: string;
}

export type OktaFlowState =
  | { kind: "success" }
  | { kind: "error"; message: string }
  | { kind: "webauthn" }
  | { kind: "verifying" }
  | { kind: "identifier" }
  | { kind: "wait" };

/** Pure state machine over one probe; the ceremony only acts on it. */
export function classifyOktaFlow(probe: OktaProbe): OktaFlowState {
  if (isLoginSuccess(probe.url)) return { kind: "success" };
  if (probe.error) return { kind: "error", message: probe.error };
  if (probe.webauthn) return { kind: "webauthn" };
  if (probe.verifying) return { kind: "verifying" };
  if (probe.identifier) return { kind: "identifier" };
  return { kind: "wait" };
}

const PROBE_EXPR =
  "(() => {" +
  " const vis = (s) => { const e = document.querySelector(s); return !!(e && (e.offsetParent || e.getClientRects().length)); };" +
  " const errEl = document.querySelector('.o-form-error-container');" +
  " const error = errEl ? (errEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) : '';" +
  " const heading = (document.querySelector('h2')?.textContent || '').trim();" +
  " const verifying = location.origin === 'https://onevu.vanderbilt.edu' && heading === 'Verify with Security Key or Biometric Authenticator' && vis('[data-se=switchAuthenticator]');" +
  " return { url: location.href, identifier: vis('input[name=identifier]'), webauthn: vis('[data-se=webauthn] [data-se=button]'), verifying, error };" +
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
  // A remembered-user page can start navigator.credentials.get as soon as it loads. Attach
  // the authenticator and credential before navigation, not after an assertion has started.
  return withCdpTab(opts.cdpUrl, "about:blank", async (tab) => {
    const { send, evaluate } = tab;
    const checkAbort = () => opts.signal?.throwIfAborted();
    checkAbort();
    await send("Page.enable");
    checkAbort();
    const signCountUsed = (Number(opts.passkey.signCount) || 0) + 1;
    let credentialSignCount = signCountUsed;
    let observedSignCount = signCountUsed;
    let au: { authenticatorId: string } | undefined;
    let armed = false;
    let stopping: Promise<unknown> | undefined;
    let accountingFailure: CounterAccountingError | undefined;
    const stopPresence = () => {
      if (au && armed) stopping ??= send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: au!.authenticatorId, enabled: false });
      // Attach immediately: an abort event must never create an unhandled rejection.
      void stopping?.catch(() => {});
    };
    opts.signal?.addEventListener("abort", stopPresence);
    const installAuthenticator = async () => {
      checkAbort();
      await send("WebAuthn.enable");
      checkAbort();
      const authenticator = await send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: false },
      });
      au = authenticator;
      checkAbort();
      await send("WebAuthn.addCredential", {
        authenticatorId: authenticator.authenticatorId,
        credential: {
          credentialId: toCdpB64(opts.passkey.credentialId),
          isResidentCredential: opts.passkey.isResidentCredential ?? false,
          rpId: opts.passkey.rpId,
          privateKey: toCdpB64(opts.passkey.privateKey),
          userHandle: toCdpB64(opts.passkey.userHandle),
          signCount: credentialSignCount,
        },
      });
      return authenticator;
    };
    const assertedCounter = async () => {
      const { credentials } = await send<{ credentials: Array<{ credentialId: string; signCount: number }> }>("WebAuthn.getCredentials", { authenticatorId: au!.authenticatorId });
      const count = credentials.find(c => toCdpB64(c.credentialId) === toCdpB64(opts.passkey.credentialId))?.signCount;
      if (typeof count !== "number" || !Number.isFinite(count) || count < credentialSignCount)
        throw new Error("Authenticator counter unavailable or regressed");
      return count > credentialSignCount ? count : undefined;
    };
    // Quiesce before observing a final counter. No cancellation races this cleanup.
    const drainCounter = async () => {
      if (accountingFailure) throw accountingFailure;
      if (!au || !armed) return;
      try {
        stopPresence();
        await stopping;
        await send("Page.navigate", { url: "about:blank" });
        const count = await assertedCounter();
        observedSignCount = Math.max(observedSignCount, count ?? credentialSignCount);
        if (observedSignCount > signCountUsed) await opts.accountCounter?.(observedSignCount);
        armed = false;
      } catch (cause) { accountingFailure = new CounterAccountingError(cause); throw accountingFailure; }
    };
    const navigateLogin = async () => {
      checkAbort();
      armed = true; // Treat even a failed CDP response as potentially issued.
      await send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId: au!.authenticatorId, enabled: true });
      checkAbort();
      await send("Page.navigate", { url: loginUrl });
    };
    try {
      await installAuthenticator();
      await navigateLogin();

      const deadline = Date.now() + timeoutMs;
      let finalUrl = "";
      let identifierSubmits = 0;
      let webauthnClicks = 0;
      let verificationStarted: number | undefined;
      let verificationRestarts = 0;
      let first = true;
      while (Date.now() < deadline) {
        await sleep(first ? 2500 : stepMs);
        first = false;
        checkAbort();
        const probe = (await evaluate(PROBE_EXPR).catch(() => null)) as OktaProbe | null;
        checkAbort();
        if (!probe) continue; // mid-navigation; probe again
        finalUrl = String(probe.url ?? "");
        const state = classifyOktaFlow(probe);
        if (state.kind !== "verifying") verificationStarted = undefined;
        if (state.kind === "success") {
          let assertedSignCount: number | undefined;
          if (opts.requireAssertion) {
            let exactHome = false;
            try {
              const success = new URL(finalUrl);
              exactHome = success.origin === "https://onevu.vanderbilt.edu" && success.pathname === "/app/UserHome";
            } catch { /* reject malformed success URL */ }
            if (!exactHome) throw new AuthError("OKTA_FLOW_CHANGED", "Passkey verification did not finish on OneVU's authenticated home; no verified session was returned.", { retryable: false });
            const asserted = await send<{ credentials: Array<{ credentialId: string; signCount: number }> }>("WebAuthn.getCredentials", { authenticatorId: au!.authenticatorId });
            const key = asserted.credentials.find((credential) => toCdpB64(credential.credentialId) === toCdpB64(opts.passkey.credentialId));
            if (key && Number.isFinite(key.signCount) && key.signCount > credentialSignCount) observedSignCount = Math.max(observedSignCount, key.signCount);
            if (!key || !Number.isFinite(key.signCount) || observedSignCount <= signCountUsed)
              throw new AuthError("OKTA_REJECTED", "OneVU reached a signed-in page without a verified assertion from the newly enrolled toolkit passkey; no verified session was returned.", { retryable: false });
            assertedSignCount = observedSignCount;
          }
          await drainCounter();
          checkAbort();
          if (observedSignCount > signCountUsed) assertedSignCount = observedSignCount;
          const cookies = await harvestCookies(send);
          const expiries = cookies.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
          return {
            cookies,
            acquiredAt: new Date().toISOString(),
            expiresAt: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : undefined,
            finalUrl,
            signCountUsed,
            ...(opts.requireAssertion ? { passkeyVerified: true, assertedSignCount } : {}),
          };
        }
        if (state.kind === "error") {
          throw new AuthError("OKTA_REJECTED", `OneVU sign-in showed an error: "${state.message}"`, { retryable: true });
        }
        if (state.kind === "webauthn" && webauthnClicks < 3) {
          if ((await evaluate(`(${CLICK_VISIBLE})('[data-se=webauthn] [data-se=button]')`).catch(() => false)) === true) webauthnClicks++;
          continue;
        }
        if (state.kind === "verifying") {
          verificationStarted ??= Date.now();
          // This screen starts WebAuthn automatically. Give the real assertion time, then
          // rebuild both the document and authenticator before restarting OneVU. Switching
          // methods or reloading alone leaves a late-installed authenticator unusable.
          // Never fall back to passwords, disable MFA, or depend on a nonexistent Verify button.
          if (Date.now() - verificationStarted >= 10_000 && verificationRestarts < 2) {
            // Chromium may increment the counter before presence completes, while get() is
            // still pending. Preserve that counter across authenticator replacement rather
            // than treating it alone as proof of a completed login.
            await drainCounter();
            checkAbort();
            await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: au!.authenticatorId });
            au = undefined;
            await send("WebAuthn.disable", {});
            checkAbort();
            credentialSignCount = Math.max(credentialSignCount, observedSignCount) + 1;
            stopping = undefined;
            await installAuthenticator();
            await navigateLogin();
            verificationRestarts++;
            verificationStarted = undefined;
            identifierSubmits = 0;
            webauthnClicks = 0;
          }
          continue;
        }
        if (state.kind === "identifier" && identifierSubmits < 2) {
          const filled = await evaluate(`(${FILL_NATIVE})('input[name=identifier]', ${JSON.stringify(opts.email)})`).catch(() => false);
          checkAbort();
          if (filled !== true) continue;
          await evaluate(KEEP_SIGNED_IN).catch(() => false);
          checkAbort();
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
    } finally {
      try { await drainCounter(); }
      finally {
        opts.signal?.removeEventListener("abort", stopPresence);
        if (au) await send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: au.authenticatorId }).catch(() => {});
      }
    }
  }, { isolated: opts.requireAssertion === true });
}
