/** Deterministic first-time/recovery setup. Tool arguments never contain credentials. */
import { join } from "node:path";
import { FileSessionStore, harvestToStoredSession } from "../vault/file-store.js";
import { CLICK_VISIBLE, FILL_NATIVE, withCdpTab, type CdpTab } from "./cdp-driver.js";
import { runSsoCeremony, type VaultPasskey } from "./ceremony.js";
import { defaultSecretsRead, ensureSession, parseVaultPasskey } from "./ensure.js";
import { advancePasskeyCounter, enrollSetup, SETTINGS_URL, SetupError, validateCredential, type SetupDeps } from "./setup.js";
import { ensureBrowser, resolveBrowser } from "./browser-config.js";
import { AuthError } from "./errors.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ONEVU_ORIGIN = "https://onevu.vanderbilt.edu";

function safeFailureCode(error: unknown): string {
  if (error instanceof AuthError || error instanceof SetupError) return error.code;
  return "MICROSOFT_UNAVAILABLE";
}
const MICROSOFT_NEXT_STEP = "Run sessions.ensure(microsoft) after resolving the reported Microsoft or browser prerequisite; Vanderbilt setup remains usable.";

export interface RunOptions {
  /** Account-holder authorization to enroll a new OneVU passkey when required. */
  confirm: boolean;
  /** Use only a pre-existing browser session. Never submit credentials or initiate phone MFA. */
  allowInteractiveVerification?: boolean;
  /** Explicit recovery of a key already rejected by OneVU. The old key is never loaded. */
  recovery?: boolean;
  timeoutSeconds?: number;
}

export interface RunDeps extends SetupDeps {
  ensure?: (idp: "vanderbilt" | "microsoft") => Promise<{ source: "cache" | "minted"; healthy: boolean }>;
  verifyPasskey?: (passkey: VaultPasskey, cdpUrl: string, email: string, expectedRaw: string) => Promise<boolean>;
}

type LoginPage = {
  url: string;
  security: boolean;
  identifier: boolean;
  password: boolean;
  challenge: boolean;
  error: boolean;
};

const LOGIN_PROBE = `(() => {
  const visible = e => !!(e && (e.offsetParent || e.getClientRects().length));
  const url = location.href;
  const trusted = location.origin === '${ONEVU_ORIGIN}';
  const body = (document.body?.innerText || '').slice(0, 6000);
  const errorText = (document.querySelector('.o-form-error-container')?.textContent || '').trim();
  return { url,
    security: trusted && location.pathname === '/account-settings/security',
    identifier: trusted && visible(document.querySelector('input[name="identifier"]')),
    password: trusted && visible(document.querySelector('input[type="password"]')),
    challenge: trusted && /Okta Verify|push notification|check your phone|verify it.s you|verification code|enter a code/i.test(body),
    error: trusted && !!errorText && visible(document.querySelector('.o-form-error-container'))
  };
})()`;

function vaultValue(name: string, deps: RunDeps): string | undefined {
  try { return (deps.read ?? defaultSecretsRead)(name) || undefined; } catch { return undefined; }
}

function sameCredential(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const first = parseVaultPasskey(a);
    const second = parseVaultPasskey(b);
    return first.credentialId === second.credentialId && first.privateKey === second.privateKey;
  } catch { return false; }
}

function identity(deps: RunDeps): string {
  const env = deps.env ?? process.env;
  const email = env.VUTOOLKIT_VU_EMAIL || vaultValue("VANDERBILT_EMAIL", deps);
  const vunetId = env.VUTOOLKIT_VUNETID || vaultValue("VANDERBILT_VUNETID", deps);
  const resolved = email || (vunetId ? `${vunetId}@vanderbilt.edu` : undefined);
  if (!resolved || !/^[^\s@]+@vanderbilt\.edu$/i.test(resolved))
    throw new SetupError("IDENTITY_REQUIRED", "Configure VANDERBILT_EMAIL or VANDERBILT_VUNETID in this host's vault before setup.run.");
  return resolved.toLowerCase();
}

async function driveSignIn(tab: CdpTab, email: string, options: Required<RunOptions>, deps: RunDeps): Promise<void> {
  const end = (deps.now ?? Date.now)() + options.timeoutSeconds * 1000;
  let submittedIdentifier = false;
  let submittedPassword = false;
  let sawChallenge = false;
  const startedAt = (deps.now ?? Date.now)();
  const wait = deps.wait ?? sleep;
  while ((deps.now ?? Date.now)() < end) {
    const page = await tab.evaluate(LOGIN_PROBE).catch(() => null) as LoginPage | null;
    if (!page) { await wait(1000); continue; }
    if (page.security) return;
    let url: URL;
    try { url = new URL(page.url); } catch { throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU returned an unrecognized page; setup made no credential submission."); }
    if (url.origin !== ONEVU_ORIGIN) {
      if ((url.protocol === "about:" || url.protocol === "chrome:") && (deps.now ?? Date.now)() - startedAt < 15_000) {
        await wait(1000);
        continue;
      }
      throw new SetupError("BROWSER_FLOW_CHANGED", "The setup tab left OneVU; no credentials were entered on that page.");
    }
    if (page.error) throw new SetupError("OKTA_REJECTED", "OneVU rejected the sign-in. Verify this account's login prerequisites without repeating MFA blindly.");
    sawChallenge ||= page.challenge;
    if (!options.allowInteractiveVerification) {
      // In particular, do not submit a password here: doing so may itself send a phone push.
      await wait(1000);
      continue;
    }
    if (page.identifier && !submittedIdentifier) {
      const filled = await tab.evaluate(`(() => {
        if (location.origin !== '${ONEVU_ORIGIN}') return false;
        return (${FILL_NATIVE})('input[name="identifier"]', ${JSON.stringify(email)});
      })()`);
      if (filled !== true) throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU's identifier control changed; no sign-in was submitted.");
      // Some OneVU variants put identifier and password on the same form. Fill both before
      // its sole submit; an identifier-only submit can otherwise trigger an avoidable error.
      if (page.password) {
        const password = vaultValue("VANDERBILT_PASSWORD", deps);
        if (!password) throw new SetupError("PASSWORD_REQUIRED", "No authenticated OneVU session was found. Set VANDERBILT_PASSWORD in this host's vault, or sign in through the selected browser, then retry setup.run.");
        const passwordFilled = await tab.evaluate(`(() => {
          if (location.origin !== '${ONEVU_ORIGIN}') return false;
          return (${FILL_NATIVE})('input[type="password"]', ${JSON.stringify(password)});
        })()`);
        if (passwordFilled !== true) throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU's password control changed; no sign-in was submitted.");
      }
      const clicked = await tab.evaluate(`(() => {
        if (location.origin !== '${ONEVU_ORIGIN}') return false;
        return (${CLICK_VISIBLE})('input[type="submit"],button[type="submit"]');
      })()`);
      if (clicked !== true) throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU's identifier submit control changed; no sign-in was submitted.");
      submittedIdentifier = true;
      if (page.password) submittedPassword = true;
    } else if (page.password && !submittedPassword) {
      const password = vaultValue("VANDERBILT_PASSWORD", deps);
      if (!password) throw new SetupError("PASSWORD_REQUIRED", "No authenticated OneVU session was found. Set VANDERBILT_PASSWORD in this host's vault, or sign in through the selected browser, then retry setup.run.");
      // Evaluate only on the exact trusted origin; the password never enters tool arguments or output.
      const filled = await tab.evaluate(`(() => {
        if (location.origin !== '${ONEVU_ORIGIN}') return false;
        return (${FILL_NATIVE})('input[type="password"]', ${JSON.stringify(password)});
      })()`);
      if (filled !== true) throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU's password control changed; no password was submitted.");
      const clicked = await tab.evaluate(`(() => {
        if (location.origin !== '${ONEVU_ORIGIN}') return false;
        return (${CLICK_VISIBLE})('input[type="submit"],button[type="submit"]');
      })()`);
      if (clicked !== true) throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU's password submit control changed; no password was submitted.");
      submittedPassword = true;
    }
    await wait(1000);
  }
  if (!options.allowInteractiveVerification)
    throw new SetupError("EXISTING_SESSION_REQUIRED", "No authenticated OneVU session appeared in the selected browser. No password was submitted and no phone verification was initiated.");
  if (sawChallenge) throw new SetupError("MFA_REQUIRED", "OneVU is waiting for the account holder's one-time verification. Approve the existing request once, then retry setup.run; setup will reuse the browser session.");
  throw new SetupError("BROWSER_FLOW_CHANGED", "OneVU did not reach authenticated security settings before the timeout. Inspect the selected browser tab; no sign-in step was repeated.");
}

const inFlight = new Map<string, { signature: string; promise: Promise<Awaited<ReturnType<typeof runOnce>>> }>();

async function runOnce(dataDir: string, raw: RunOptions, deps: RunDeps) {
  if (raw.confirm !== true) throw new SetupError("CONFIRMATION_REQUIRED", "The account holder must authorize enrolling a toolkit passkey before setup.run.");
  const options: Required<RunOptions> = {
    confirm: true,
    allowInteractiveVerification: raw.allowInteractiveVerification ?? true,
    recovery: raw.recovery ?? false,
    timeoutSeconds: raw.timeoutSeconds ?? 180,
  };
  const email = identity(deps);
  const env = deps.env ?? process.env;
  const existing = env.VUTOOLKIT_PASSKEY_JSON || vaultValue("VANDERBILT_PASSKEY", deps);
  const pending = vaultValue("VANDERBILT_PASSKEY_PENDING", deps);
  if (existing) {
    try { validateCredential(parseVaultPasskey(existing)); }
    catch { throw new SetupError("INVALID_PASSKEY", "The existing toolkit passkey is malformed. Preserve it and repair the host vault before setup.run; it will not be overwritten automatically."); }
  }
  const store = new FileSessionStore(join(dataDir, "sessions.vault.json"));
  let selectedCdpUrl: string | undefined;
  const ensure = deps.ensure ?? ((idp: "vanderbilt" | "microsoft") => ensureSession(idp, store, {
    env: { ...env, VUTOOLKIT_VU_EMAIL: email, ...(selectedCdpUrl ? { VUTOOLKIT_CDP_URL: selectedCdpUrl } : {}) },
  }));
  const verifyPasskey = deps.verifyPasskey ?? (async (passkey: VaultPasskey, cdpUrl: string, identityEmail: string, expectedRaw: string) => {
    const minted = await runSsoCeremony({ cdpUrl, email: identityEmail, passkey,
      requireAssertion: true, timeoutMs: options.timeoutSeconds * 1000 });
    if (!minted.passkeyVerified || !minted.assertedSignCount) return false;
    advancePasskeyCounter(expectedRaw, minted.assertedSignCount, deps);
    await store.put(harvestToStoredSession("vanderbilt", minted.cookies, minted.acquiredAt));
    return true;
  });
  if (existing && !options.recovery) {
    const selection = deps.browserReady
      ? { cdpUrl: env.VUTOOLKIT_CDP_URL || "http://127.0.0.1:18800", canStart: false, source: "endpoint" as const }
      : await resolveBrowser(env);
    try {
      await (deps.browserReady ? deps.browserReady(selection.cdpUrl) : ensureBrowser(selection));
      selectedCdpUrl = selection.cdpUrl;
      if (!await verifyPasskey(validateCredential(parseVaultPasskey(existing)), selection.cdpUrl, email, existing))
        throw new SetupError("PASSKEY_UNVERIFIED", "The existing key did not complete an isolated OneVU assertion.");
    } catch (error) {
      if (error instanceof AuthError && error.code !== "OKTA_REJECTED") throw error;
      if (error instanceof SetupError && error.code !== "PASSKEY_UNVERIFIED") throw error;
      throw new SetupError("RECOVERY_REQUIRED", "The existing toolkit passkey could not establish a healthy OneVU session. If OneVU rejected it, retry setup.run with recovery=true; the old key will be preserved.");
    }
    let microsoftSession: "ready" | "not-ready" = "ready";
    let microsoftError: string | undefined;
    try { const ms = await ensure("microsoft"); if (!ms.healthy) { microsoftSession = "not-ready"; microsoftError = "MICROSOFT_SESSION_UNHEALTHY"; } }
    catch (error) { microsoftSession = "not-ready"; microsoftError = safeFailureCode(error); }
    return { status: microsoftSession === "ready" ? "ready" as const : "partial" as const,
      passkey: "existing" as const, vanderbiltSession: "ready" as const, microsoftSession,
      passkeyAssertion: "verified" as const,
      ...(microsoftError ? { microsoftError, microsoftNextStep: MICROSOFT_NEXT_STEP } : {}), verificationRequired: false as const };
  }
  if (options.recovery && !existing) throw new SetupError("NO_EXISTING_PASSKEY", "Recovery was requested but this host has no existing toolkit passkey. Retry without recovery=true.");
  if (pending && !sameCredential(pending, existing)) throw new SetupError("PENDING_ENROLLMENT", "A prior enrollment staged a pending key without verified OneVU acknowledgement. Setup will not create a duplicate key or overwrite it; inspect the pending enrollment and resume only after verification.");

  const selection = deps.browserReady
    ? { cdpUrl: env.VUTOOLKIT_CDP_URL || "http://127.0.0.1:18800", canStart: false, source: "endpoint" as const }
    : await resolveBrowser(env);
  const cdpUrl = selection.cdpUrl;
  selectedCdpUrl = cdpUrl;
  try { await (deps.browserReady ? deps.browserReady(cdpUrl) : ensureBrowser(selection)); }
  catch { throw new SetupError("BROWSER_UNAVAILABLE", "The selected managed browser could not be started or reached. Check the configured browser profile/CDP endpoint."); }
  await (deps.tab ?? withCdpTab)(cdpUrl, SETTINGS_URL, (tab) => driveSignIn(tab, email, options, deps), { keepOpen: true });

  const enrollmentDeps: RunDeps = { ...deps, env: { ...env, VUTOOLKIT_VU_EMAIL: email, VUTOOLKIT_CDP_URL: cdpUrl }, browserReady: async () => {} };
  const enrolled = await enrollSetup({ confirm: true, replaceExisting: options.recovery,
    timeoutSeconds: options.timeoutSeconds, allowInteractiveVerification: options.allowInteractiveVerification }, enrollmentDeps);
  if (enrolled.status !== "enrolled" || !enrolled.serverConfirmed)
    throw new SetupError("ENROLLMENT_UNCONFIRMED", "OneVU has not acknowledged the new passkey. A pending key may be staged in the host vault; no cookie-only setup was declared successful.");
  const promoted = vaultValue("VANDERBILT_PASSKEY", deps);
  if (!promoted) throw new SetupError("VAULT_VERIFY_FAILED", "The enrolled passkey could not be read from this host's vault for an independent assertion.");
  try {
    if (!await verifyPasskey(validateCredential(parseVaultPasskey(promoted)), cdpUrl, email, promoted))
      throw new SetupError("PASSKEY_UNVERIFIED", "The enrolled key did not complete an isolated OneVU assertion.");
  } catch (error) {
    if (error instanceof AuthError && error.code === "BROWSER_UNAVAILABLE") throw error;
    if (error instanceof SetupError && ["CREDENTIAL_CHANGED", "PASSKEY_COUNTER_INVALID", "VAULT_VERIFY_FAILED"].includes(error.code)) throw error;
    throw new SetupError("PASSKEY_UNVERIFIED", "OneVU acknowledged the new passkey, but it has not yet passed an independent isolated sign-in. The credential remains safely vaulted; retry setup.run to verify it before claiming readiness.");
  }
  let microsoftSession: "ready" | "not-ready" = "ready";
  let microsoftError: string | undefined;
  try { const ms = await ensure("microsoft"); if (!ms.healthy) { microsoftSession = "not-ready"; microsoftError = "MICROSOFT_SESSION_UNHEALTHY"; } }
  catch (error) { microsoftSession = "not-ready"; microsoftError = safeFailureCode(error); }
  return { status: microsoftSession === "ready" ? "ready" as const : "partial" as const,
    passkey: options.recovery ? "recovered" as const : "enrolled" as const,
    vanderbiltSession: "ready" as const, microsoftSession, passkeyAssertion: "verified" as const,
    ...(microsoftError ? { microsoftError, microsoftNextStep: MICROSOFT_NEXT_STEP } : {}), verificationRequired: false as const };
}

/** One deterministic tool call. Concurrent calls in the same host process share the same attempt. */
export function runSetup(dataDir: string, options: RunOptions, deps: RunDeps = {}) {
  const signature = JSON.stringify({ confirm: options.confirm, recovery: options.recovery ?? false,
    allowInteractiveVerification: options.allowInteractiveVerification ?? true, timeoutSeconds: options.timeoutSeconds ?? 180 });
  const active = inFlight.get(dataDir);
  if (active) {
    if (active.signature !== signature) throw new SetupError("SETUP_IN_PROGRESS", "A different setup attempt is already running for this host. Wait for it to finish before changing recovery or verification settings.");
    return active.promise;
  }
  const run = runOnce(dataDir, options, deps).finally(() => inFlight.delete(dataDir));
  inFlight.set(dataDir, { signature, promise: run });
  return run;
}
