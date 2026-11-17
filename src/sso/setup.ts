import { checkAuthAbort } from "./budget.js";
/** OneVU's real self-service enrollment, with credential material confined to CDP and the vault. */
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { cdpReachable, withCdpTab, type CdpTab } from "./cdp-driver.js";
import { toCdpB64, type VaultPasskey } from "./ceremony.js";
import { defaultSecretsRead, parseVaultPasskey } from "./ensure.js";
import type { defaultEnsureBrowser } from "./ensure.js";
import { ensureBrowser, resolveBrowser } from "./browser-config.js";

export const SETTINGS_URL = "https://onevu.vanderbilt.edu/account-settings/security";

/**
 * OneVU's "Verify it's you with a security method" chooser lists Okta Verify's code, its push,
 * phone and security key, each with its own "Select". Waiting on that page never sends anything,
 * so interactive setup picks the push row (and, where Okta shows one, its "Send push" button).
 * Only the row whose own text names a push notification is eligible: a "Select" whose nearest
 * ancestor already holds a second "Select" belongs to a list, not a row, and is never clicked.
 * Returns "select", "send" or false. Never runs on the account settings pages.
 */
export const SELECT_PUSH = `(() => {
  if (location.origin !== 'https://onevu.vanderbilt.edu' || location.pathname.startsWith('/account-settings/')) return false;
  const vis = e => !!(e && (e.offsetParent || e.getClientRects().length));
  const label = e => (e.value || e.textContent || '').trim();
  const selects = [...document.querySelectorAll('[data-se="button"],a,button,input[type="submit"]')].filter(e => vis(e) && /^Select$/i.test(label(e)));
  const rowOf = b => {
    for (let n = b.parentElement; n && n !== document.body; n = n.parentElement) {
      if (selects.filter(s => n.contains(s)).length > 1) return null;
      if (/push notification/i.test(n.textContent || '')) return n;
    }
    return null;
  };
  const direct = document.querySelector('[data-se="okta_verify-push"] [data-se="button"]');
  const pick = vis(direct) ? direct : selects.find(rowOf);
  if (pick) { pick.click(); return 'select'; }
  const send = [...document.querySelectorAll('input[type="submit"],button[type="submit"],button,a.button')]
    .find(e => vis(e) && /^Send push$/i.test(label(e)));
  if (send) { send.click(); return 'send'; }
  return false;
})()`;
/** At most this many chooser clicks per setup step (select, then send), so a stalled page cannot spam the phone. */
export const MAX_FACTOR_CLICKS = 3;
export const MAX_AUTHENTICATOR_RESETS = 10;
/** Okta's hint while a push is pending; it shares the error container but is not a rejection. */
export const PUSH_WAIT_HINT = /haven.t received a push|try opening the okta verify|push notification sent|resend push/i;
const SECRET_NAME = "VANDERBILT_PASSKEY";
const PENDING_SECRET_NAME = "VANDERBILT_PASSKEY_PENDING";
const PREVIOUS_SECRET_NAME = "VANDERBILT_PASSKEY_PREVIOUS";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SetupDeps {
  env?: NodeJS.ProcessEnv;
  read?: (name: string) => string;
  write?: (name: string, value: string) => void;
  browserReady?: typeof defaultEnsureBrowser;
  reachable?: typeof cdpReachable;
  tab?: typeof withCdpTab;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class SetupError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SetupError";
  }
}

function readOptional(name: string, deps: SetupDeps): string | undefined {
  try { return (deps.read ?? defaultSecretsRead)(name) || undefined; } catch { return undefined; }
}

function matchesCredential(raw: string | undefined, expected: VaultPasskey): boolean {
  if (!raw) return false;
  try {
    const actual = parseVaultPasskey(raw);
    return actual.credentialId === expected.credentialId && actual.privateKey === expected.privateKey;
  } catch { return false; }
}

function credentials(deps: SetupDeps) {
  const env = deps.env ?? process.env;
  const vunetId = env.VUTOOLKIT_VUNETID || readOptional("VANDERBILT_VUNETID", deps);
  const email = env.VUTOOLKIT_VU_EMAIL || readOptional("VANDERBILT_EMAIL", deps) || (vunetId ? `${vunetId}@vanderbilt.edu` : undefined);
  const raw = env.VUTOOLKIT_PASSKEY_JSON || readOptional(SECRET_NAME, deps);
  let passkey: VaultPasskey | undefined;
  if (raw) {
    try { passkey = validateCredential(parseVaultPasskey(raw)); } catch { /* status only */ }
  }
  return { email, vunetId, raw, passkey, cdpUrl: env.VUTOOLKIT_CDP_URL || "http://127.0.0.1:18800" };
}

async function browserSelection(deps: SetupDeps) {
  const env = deps.env ?? process.env;
  // The injected browser hook belongs to tests/host shims which supply their own endpoint.
  return deps.browserReady
    ? { cdpUrl: env.VUTOOLKIT_CDP_URL || "http://127.0.0.1:18800", canStart: false, source: "endpoint" as const }
    : resolveBrowser(env);
}

export function validateCredential(value: VaultPasskey): VaultPasskey {
  try {
    if (!value.credentialId || !value.privateKey || !Number.isInteger(value.signCount) || value.signCount < 0 || value.signCount > 0xffffffff) throw new Error();
    if (value.rpId !== "vanderbilt.edu" && !value.rpId.endsWith(".vanderbilt.edu")) throw new Error();
    const key = createPrivateKey({ key: Buffer.from(toCdpB64(value.privateKey), "base64"), type: "pkcs8", format: "der" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    return value;
  } catch {
    throw new SetupError("INVALID_PASSKEY", "The configured passkey is not a supported Vanderbilt P-256 credential; no value was changed.");
  }
}

/** Existing auth uses the host's readable vault entry; never a plaintext file or command argument. */
function writeVault(name: string, value: string): void {
  try {
    execFileSync("openclaw", ["secrets", "store", "set", name, "--kind", "env", "--value-file", "-"], {
      input: value, timeout: 20_000, stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    throw new SetupError("VAULT_WRITE_FAILED", "The native vault could not store the credential. No credential value was returned or written to a file.");
  }
}

/** Persist the authenticator's observed post-assertion counter without replacing another key. */
export function advancePasskeyCounter(expectedRaw: string, assertedSignCount: number, deps: SetupDeps = {}): void {
  const current = readOptional(SECRET_NAME, deps);
  if (current !== expectedRaw) throw new SetupError("CREDENTIAL_CHANGED", "The active passkey changed before its verified assertion counter could be saved.");
  const key = validateCredential(parseVaultPasskey(current));
  if (!Number.isInteger(assertedSignCount) || assertedSignCount <= key.signCount || assertedSignCount > 0xffffffff)
    throw new SetupError("PASSKEY_COUNTER_INVALID", "The isolated assertion did not advance the passkey counter; the vault entry was not changed.");
  const updated = JSON.stringify({ ...key, signCount: assertedSignCount });
  const write = deps.write ?? writeVault;
  write(SECRET_NAME, updated);
  if (readOptional(SECRET_NAME, deps) !== updated) {
    write(SECRET_NAME, current);
    throw new SetupError("VAULT_VERIFY_FAILED", "The verified passkey counter was not confirmed in the host vault; the previous value was restored.");
  }
}

/** Non-sensitive status; a valid existing key is never rotated merely to complete setup. */
export async function setupStatus(deps: SetupDeps = {}) {
  const auth = credentials(deps);
  const browserAvailable = await (deps.reachable ?? cdpReachable)((await browserSelection(deps)).cdpUrl);
  return {
    identityConfigured: Boolean(auth.email || auth.vunetId),
    emailConfigured: Boolean(auth.email),
    passkeyConfigured: Boolean(auth.raw),
    passkeyValid: Boolean(auth.passkey),
    browserAvailable,
    readyForAuth: Boolean(auth.email && auth.passkey && browserAvailable),
    authenticated: false as const,
    settingsUrl: SETTINGS_URL,
    nextStep: auth.email && auth.passkey
      ? (!browserAvailable
          ? "A toolkit passkey is structurally valid, but the managed browser is unavailable; setup is not ready. Restore the host's managed CDP browser, then check setup again. Structural validity does not prove OneVU accepts the key."
          : "A toolkit passkey is configured and structurally valid, but that does not prove OneVU accepts it. Use sessions.ensure; if OneVU rejects it, explicitly start recovery in setup before issuing a replacement.")
      : !auth.email
        ? "Set your Vanderbilt email in the host's VANDERBILT_EMAIL vault entry, then prepare enrollment."
        : auth.raw
          ? "An existing passkey entry needs attention. Setup will not overwrite it."
          : "Prepare enrollment, complete your first OneVU sign-in in the managed browser, then explicitly enroll the toolkit passkey.",
  };
}

/** Only non-secret identifiers enter tool arguments. Keys/passwords never do. */
export function configureIdentity(options: { email?: string; vunetId?: string }, deps: SetupDeps = {}) {
  const vunetId = options.vunetId?.trim();
  const email = options.email?.trim().toLowerCase() || (vunetId ? `${vunetId.toLowerCase()}@vanderbilt.edu` : undefined);
  if (!email || !/^[^\s@]+@vanderbilt\.edu$/i.test(email) || (vunetId && !/^[a-z0-9._-]+$/i.test(vunetId)))
    throw new SetupError("IDENTITY_REQUIRED", "Provide a Vanderbilt email or VUnetID; no password or passkey belongs in this form.");
  const auth = credentials(deps);
  if (auth.raw && auth.email?.toLowerCase() !== email)
    throw new SetupError("EXISTING_ACCOUNT", "An existing passkey is bound to this configured account. Setup will not replace its identity.");
  const write = deps.write ?? writeVault;
  write("VANDERBILT_EMAIL", email);
  if (readOptional("VANDERBILT_EMAIL", deps) !== email)
    throw new SetupError("VAULT_VERIFY_FAILED", "The configured email could not be confirmed in the host vault; no identity was changed.");
  if (vunetId) {
    write("VANDERBILT_VUNETID", vunetId);
    if (readOptional("VANDERBILT_VUNETID", deps) !== vunetId)
      throw new SetupError("VAULT_VERIFY_FAILED", "The configured VUnetID could not be confirmed in the host vault; the email was written but VUnetID was not confirmed.");
  }
  return { identityConfigured: true, emailConfigured: true, vunetIdConfigured: Boolean(vunetId || auth.vunetId), emailDerivedFromVunetId: !options.email };
}

interface SecurityPage {
  authenticated: boolean;
  identityMatched: boolean;
  enrollmentAvailable: boolean;
  enrolledCount: number;
  signInRequired: boolean;
}

// OneVU uses Okta session endpoints on the same origin. Compare the current session's login (or
// the corresponding current-user profile) to the configured identity in browser memory; no
// account data is returned from this probe.
const PAGE_PROBE = (email: string, verifyIdentity = true) => `(async () => {
  const correctOrigin = location.origin === 'https://onevu.vanderbilt.edu';
  const expectedEmail = ${JSON.stringify(email.toLowerCase())};
  const identityMatched = correctOrigin && ${verifyIdentity} ? (async () => {
    const readJson = async path => {
      try { const response = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } }); return response.ok ? await response.json() : null; }
      catch { return null; }
    };
    const session = await readJson('/api/v1/sessions/me');
    const candidates = [session?.login, session?.email, session?.profile?.login, session?.profile?.email,
      session?.user?.login, session?.user?.email, session?.user?.profile?.login, session?.user?.profile?.email,
      session?._embedded?.user?.profile?.login, session?._embedded?.user?.profile?.email];
    if (candidates.some(value => typeof value === 'string' && value.trim().toLowerCase() === expectedEmail)) return true;
    const user = await readJson('/api/v1/users/me');
    return [user?.login, user?.email, user?.profile?.login, user?.profile?.email,
      user?.user?.profile?.login, user?.user?.profile?.email, user?._embedded?.user?.profile?.login, user?._embedded?.user?.profile?.email]
      .some(value => typeof value === 'string' && value.trim().toLowerCase() === expectedEmail);
  })() : Promise.resolve(false);
  const section = [...document.querySelectorAll('[data-se="enrolled-authenticator-container"]')]
    .find(e => /Security Key or Biometric|Passkey/i.test(e.querySelector('[data-se="enrolled-authenticator-title"]')?.textContent || ''));
  return {
    authenticated: correctOrigin && location.pathname === '/account-settings/security',
    identityMatched: await identityMatched,
    enrollmentAvailable: !!section?.querySelector('[data-se="setup-new-enrollment-button"]'),
    enrolledCount: section?.querySelectorAll('[data-se="enrolled-authenticator"]').length || 0,
    signInRequired: correctOrigin && !location.pathname.startsWith('/account-settings/')
  };
})()`;

/**
 * Records, per OneVU tab, the shape of each WebAuthn request the page makes and how it settled,
 * in sessionStorage so it survives same-origin page loads. Never records challenges, user or key
 * material. Installed for enrollment only, so a stalled enrollment can say what OneVU asked for.
 */
const WEBAUTHN_RECORDER = `(() => { try {
  if (location.origin !== 'https://onevu.vanderbilt.edu' || window.top !== window || !navigator.credentials || navigator.credentials.__vt) return;
  const KEY = '__vt_webauthn';
  const save = (fn) => { try { const all = JSON.parse(sessionStorage.getItem(KEY) || '[]'); fn(all); sessionStorage.setItem(KEY, JSON.stringify(all.slice(-6))); } catch {} };
  for (const kind of ['create', 'get']) {
    const original = navigator.credentials[kind].bind(navigator.credentials);
    navigator.credentials[kind] = function (options) {
      const pk = (options && options.publicKey) || {}; const sel = pk.authenticatorSelection || {};
      const id = Math.random().toString(36).slice(2, 8);
      save(all => all.push({ id, kind, mediation: (options && options.mediation) || '', attachment: sel.authenticatorAttachment || '',
        residentKey: sel.residentKey || (sel.requireResidentKey ? 'required' : ''), uv: sel.userVerification || pk.userVerification || '',
        attestation: pk.attestation || '', algs: (pk.pubKeyCredParams || []).map(p => p.alg), allow: (pk.allowCredentials || []).length,
        exclude: (pk.excludeCredentials || []).length, hints: pk.hints || [], outcome: 'pending' }));
      const settle = (outcome) => save(all => { const e = all.find(x => x.id === id); if (e) e.outcome = outcome; });
      return original(options).then(value => { settle('ok'); return value; }, error => { settle('error:' + (error && error.name)); throw error; });
    };
  }
  navigator.credentials.__vt = true;
} catch {} })()`;

/** Where enrollment stands, for a stalled run: path, heading, visible controls, form error, WebAuthn requests. Emails redacted, field values never read. */
const ENROLL_STATE = `(() => {
  const vis = e => !!(e && (e.offsetParent || e.getClientRects().length));
  const red = s => String(s || '').replace(/[^\\s@]+@[^\\s@]+/g, '<email>').replace(/\\s+/g, ' ').trim();
  let webauthn = []; try { webauthn = JSON.parse(sessionStorage.getItem('__vt_webauthn') || '[]').map(({ id, ...rest }) => rest); } catch {}
  return {
    path: location.origin === 'https://onevu.vanderbilt.edu' ? location.pathname : location.origin,
    heading: red(document.querySelector('[data-se="o-form-head"],h1,h2')?.textContent).slice(0, 80),
    controls: [...document.querySelectorAll('button,input[type=submit],[data-se=button]')].filter(vis)
      .map(e => red(e.value || e.innerText || e.getAttribute('aria-label')).slice(0, 30)).filter(Boolean).slice(0, 6),
    error: red(document.querySelector('.o-form-error-container,.okta-form-infobox-error,[role=alert]')?.textContent).slice(0, 120),
    text: red(document.body?.innerText).slice(0, 160),
    webauthn,
  };
})()`;

async function authenticator(tab: Pick<CdpTab, "send">, passkey?: VaultPasskey): Promise<string> {
  checkAuthAbort();
  await tab.send("WebAuthn.enable");
  const created = await tab.send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  checkAuthAbort();
  if (passkey) await tab.send("WebAuthn.addCredential", {
    authenticatorId: created.authenticatorId,
    credential: { ...passkey, credentialId: toCdpB64(passkey.credentialId), privateKey: toCdpB64(passkey.privateKey), userHandle: toCdpB64(passkey.userHandle), isResidentCredential: passkey.isResidentCredential ?? false },
  });
  return created.authenticatorId;
}

async function waitForPage(tab: CdpTab, deps: SetupDeps, email: string): Promise<SecurityPage> {
  let last: SecurityPage = { authenticated: false, identityMatched: false, enrollmentAvailable: false, enrolledCount: 0, signInRequired: false };
  // OneVU's settings shell can take 15–20s to hydrate even when the SSO session is alive.
  for (let n = 0; n < 30; n++) {
    await (deps.wait ?? sleep)(1000);
    const result = await tab.evaluate(PAGE_PROBE(email, false)).catch(() => null) as SecurityPage | null;
    if (result) last = result;
    if (last.authenticated && last.enrollmentAvailable) break;
  }
  if (last.authenticated && last.enrollmentAvailable)
    return (await tab.evaluate(PAGE_PROBE(email, true)).catch(() => null) as SecurityPage | null) ?? last;
  return last;
}

export async function prepareSetup(options: { keepTab?: boolean; recovery?: boolean } = {}, deps: SetupDeps = {}) {
  const auth = credentials(deps);
  const browser = await browserSelection(deps);
  await (deps.browserReady ? deps.browserReady(browser.cdpUrl) : ensureBrowser(browser));
  return (deps.tab ?? withCdpTab)(browser.cdpUrl, SETTINGS_URL, async (tab) => {
    let authenticatorId: string | undefined;
    try {
      if (auth.passkey && !options.recovery) authenticatorId = await authenticator(tab, auth.passkey);
      const page = await waitForPage(tab, deps, auth.email ?? "");
      return {
        status: page.authenticated && page.identityMatched && page.enrollmentAvailable ? "ready" as const : "sign-in-required" as const,
        settingsUrl: SETTINGS_URL,
        ...(options.keepTab === false ? {} : { browserTabId: tab.tabId }),
        existingPasskeyPreserved: Boolean(auth.raw),
        recoveryMode: Boolean(options.recovery),
        identityMatched: page.identityMatched,
        enrollmentAvailable: page.enrollmentAvailable,
        nextStep: options.recovery
          ? page.authenticated && page.identityMatched
            ? "Recovery mode is ready. The rejected toolkit key was not loaded. Confirm the account identity and explicitly authorize creating a replacement key."
            : "Recovery mode is open without loading the rejected key. In the OpenClaw Control UI, open the Browser panel, select the openclaw profile and this OneVU setup tab, then sign in there using your usual Vanderbilt method. Return here when complete; never send passwords or verification codes in chat. Confirm the page shows the configured account."
          : auth.passkey
          ? page.authenticated && page.identityMatched && page.enrollmentAvailable
            ? "The existing toolkit passkey was made available to this dedicated sign-in tab. It may still be rejected by OneVU; if so, choose explicit recovery."
            : `In the OpenClaw Control UI, open the Browser panel, select the openclaw profile and this OneVU setup tab, then sign in there using your usual Vanderbilt method. A separate browser login will not be shared with the toolkit. Never send passwords or verification codes in chat. Confirm the page shows this configured student's account${page.identityMatched ? "" : "; the configured email was not visible to verify identity, so do not enroll until the account identity can be confirmed"}. Return here and run setup.prepare again. The existing toolkit passkey is unchanged.`
          : page.authenticated && page.enrollmentAvailable
            ? "OneVU is ready. Explicitly confirm setup.enroll to create and vault the toolkit passkey."
            : `In the OpenClaw Control UI, open the Browser panel, select the openclaw profile and this OneVU setup tab, then sign in there using your usual Vanderbilt method. A separate browser login will not be shared with the toolkit. Never send passwords or verification codes in chat. Confirm the page shows this configured student's account${page.identityMatched ? "" : "; the configured email was not visible to verify identity, so do not enroll until the account identity can be confirmed"}. Return here and run setup.prepare again.`,
      };
    } finally {
      if (authenticatorId) await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    }
  }, { keepOpen: options.keepTab !== false });
}

export async function enrollSetup(options: { confirm: boolean; replaceExisting?: boolean; timeoutSeconds?: number; allowInteractiveVerification?: boolean }, deps: SetupDeps = {}) {
  if (options.confirm !== true) throw new SetupError("CONFIRMATION_REQUIRED", "Creating an account passkey requires explicit confirmation.");
  const auth = credentials(deps);
  if (auth.raw && options.replaceExisting !== true) throw new SetupError("EXISTING_PASSKEY", "A passkey entry already exists. It has not been changed. For an explicitly requested recovery, confirm replaceExisting after OneVU has rejected the current key.");
  if (!auth.raw && options.replaceExisting === true) throw new SetupError("NO_EXISTING_PASSKEY", "Recovery was requested but no existing key was found; use ordinary first-time enrollment.");
  if (!auth.email) throw new SetupError("IDENTITY_REQUIRED", "Configure your Vanderbilt email before enrolling a toolkit passkey.");
  // Check recovery capacity before creating an irreversible OneVU credential.
  if (auth.raw && readOptional(PREVIOUS_SECRET_NAME, deps))
    throw new SetupError("BACKUP_EXISTS", "A prior passkey recovery backup already occupies the previous-key vault slot. No new OneVU credential was created.");
  const expectedEmail = auth.email;
  const browser = await browserSelection(deps);
  await (deps.browserReady ? deps.browserReady(browser.cdpUrl) : ensureBrowser(browser));
  return (deps.tab ?? withCdpTab)(browser.cdpUrl, SETTINGS_URL, async (tab) => {
    const verified = await waitForPage(tab, deps, expectedEmail);
    if (!verified.authenticated || !verified.identityMatched || !verified.enrollmentAvailable) throw new SetupError("SIGN_IN_REQUIRED", "Use setup.prepare and complete sign-in in the managed browser. The configured account identity must be visibly verified before enrollment; no enrollment was attempted.");
    // Attach the virtual authenticator on a blank document, then reload settings, as the sign-in
    // ceremony does.
    await tab.send("Page.navigate", { url: "about:blank" });
    for (let n = 0; n < 20 && await tab.evaluate("location.href").catch(() => null) !== "about:blank"; n++) await (deps.wait ?? sleep)(250);
    let authenticatorId = await authenticator(tab);
    const recorder = await tab.send<{ identifier?: string }>("Page.addScriptToEvaluateOnNewDocument", { source: WEBAUTHN_RECORDER }).catch(() => undefined);
    const env = deps.env ?? process.env;
    let lastState = "";
    let authenticatorResets = 0;
    let staged = false;
    let enrollmentSubmitted = false;
    let serialized: string | undefined;
    let factorClicks = 0;
    try {
      await tab.send("Page.navigate", { url: SETTINGS_URL });
      const initial = await waitForPage(tab, deps, expectedEmail);
      if (!initial.authenticated || !initial.identityMatched || !initial.enrollmentAvailable) throw new SetupError("SIGN_IN_REQUIRED", "OneVU settings did not load again with the configured account after the passkey helper was attached; no enrollment was attempted.");
      const clicked = await tab.evaluate(`(() => {
        if (location.origin !== 'https://onevu.vanderbilt.edu' || location.pathname !== '/account-settings/security') return false;
        const section = [...document.querySelectorAll('[data-se="enrolled-authenticator-container"]')]
          .find(e => /Security Key or Biometric|Passkey/i.test(e.querySelector('[data-se="enrolled-authenticator-title"]')?.textContent || ''));
        const button = section?.querySelector('[data-se="setup-new-enrollment-button"]');
        if (!button) return false; button.click(); return true;
      })()`);
      if (clicked !== true) throw new SetupError("FLOW_CHANGED", "The verified OneVU passkey control was unavailable; no alternate account controls were clicked.");
      const now = deps.now ?? Date.now;
      const deadline = now() + (options.timeoutSeconds ?? 120) * 1000;
      while (now() < deadline) {
        await (deps.wait ?? sleep)(1000);
        let result: { credentials: Array<VaultPasskey> };
        try {
          result = await tab.send<{ credentials: Array<VaultPasskey> }>("WebAuthn.getCredentials", { authenticatorId });
        } catch (error) {
          // Chromium keeps one WebAuthn environment per frame and disables it when any DevTools
          // session on that frame detaches (another tool inspecting the tab, for instance). The
          // tab's own session can enable it again. Once the credential is staged it is already
          // safe in the vault, so a later loss no longer matters.
          if (staged) result = { credentials: [] };
          else if (authenticatorResets >= MAX_AUTHENTICATOR_RESETS) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new SetupError("AUTHENTICATOR_LOST", `The browser's virtual authenticator kept becoming unavailable during enrollment (${reason}). Another DevTools client attaching to and leaving the setup tab causes this. No credential was created.`);
          } else {
            authenticatorResets++;
            await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
            authenticatorId = await authenticator(tab);
            continue;
          }
        }
        if (!staged && result.credentials.length > 0) {
          if (result.credentials.length !== 1) throw new SetupError("AMBIGUOUS_CREDENTIAL", "Enrollment produced multiple credentials; no entry was overwritten.");
          const material = validateCredential(result.credentials[0]!);
          const current = readOptional(SECRET_NAME, deps);
          if (current !== auth.raw) throw new SetupError("CREDENTIAL_CHANGED", "The passkey vault entry changed during setup; the new credential was not promoted.");
          serialized = JSON.stringify(material);
          const write = deps.write ?? writeVault;
          // Stage and verify first; recovery retains the original key in the vault until the
          // new credential has been issued by OneVU and read back successfully.
          write(PENDING_SECRET_NAME, serialized);
          const stagedRaw = readOptional(PENDING_SECRET_NAME, deps);
          if (!matchesCredential(stagedRaw, material))
            throw new SetupError("VAULT_VERIFY_FAILED", "Vault readback did not confirm the new credential. The existing entry was not changed.");
          staged = true;
        }
        const state = JSON.stringify(await tab.evaluate(ENROLL_STATE).catch(() => null));
        if (state !== lastState) {
          lastState = state;
          if (env.VUTOOLKIT_SETUP_TRACE === "1") console.error(`[vutoolkit] setup: ${state}`);
        }
        const page = await tab.evaluate(PAGE_PROBE(expectedEmail)).catch(() => null) as SecurityPage | null;
        if (staged && serialized && page?.authenticated && page.identityMatched && page.enrolledCount > initial.enrolledCount) {
          const write = deps.write ?? writeVault;
          if (auth.raw) {
            if (readOptional(PREVIOUS_SECRET_NAME, deps)) throw new SetupError("BACKUP_EXISTS", "A recovery backup appeared during enrollment. The active key was not changed.");
            write(PREVIOUS_SECRET_NAME, auth.raw);
            if (readOptional(PREVIOUS_SECRET_NAME, deps) !== auth.raw) throw new SetupError("VAULT_VERIFY_FAILED", "The previous passkey backup could not be verified; the active entry was not changed.");
          }
          write(SECRET_NAME, serialized);
          const verified = readOptional(SECRET_NAME, deps);
          if (!matchesCredential(verified, parseVaultPasskey(serialized))) {
            if (auth.raw) write(SECRET_NAME, auth.raw);
            throw new SetupError("VAULT_VERIFY_FAILED", "Vault readback did not confirm the new credential. The previous credential was preserved.");
          }
          return { status: "enrolled" as const, secretName: SECRET_NAME, serverConfirmed: true, existingPasskeysRevoked: false };
        }
        if (options.allowInteractiveVerification === false) {
          const challenge = await tab.evaluate(`(() => {
            if (location.origin !== 'https://onevu.vanderbilt.edu' || location.pathname === '/account-settings/security') return false;
            const text = (document.body?.innerText || '').slice(0, 6000);
            return /Okta Verify|push notification|check your phone|verify it.s you|verification code|enter a code/i.test(text);
          })()`).catch(() => false);
          if (challenge) throw new SetupError("MFA_REQUIRED", "OneVU requested one-time verification during passkey enrollment. No verification factor was clicked. Approve the existing request when awake, then resume setup; the previous key remains available.");
        }
        // OneVU may step up before issuing a new authenticator; its chooser waits on a selection.
        if (options.allowInteractiveVerification !== false && factorClicks < MAX_FACTOR_CLICKS
          && await tab.evaluate(SELECT_PUSH).catch(() => false)) { factorClicks++; continue; }
        // Only a single enrollment-screen submit is eligible; never select a different factor.
        if (!enrollmentSubmitted && await tab.evaluate(`(() => {
          if (location.origin !== 'https://onevu.vanderbilt.edu' || location.pathname.startsWith('/account-settings/')) return false;
          const heading = document.querySelector('[data-se="o-form-head"]')?.textContent || '';
          if (!/Security Key or Biometric|Passkey/i.test(heading)) return false;
          const choices = [...document.querySelectorAll('input[type="submit"],button[type="submit"]')]
            .filter(e => /^(Set up|Enroll|Register|Continue|Create)$/i.test((e.value || e.textContent || '').trim()));
          if (choices.length !== 1) return false; choices[0].click(); return true;
        })()`).catch(() => false) === true) enrollmentSubmitted = true;
      }
      if (staged) return { status: "stored-awaiting-confirmation" as const, secretName: PENDING_SECRET_NAME, serverConfirmed: false, existingPasskeysRevoked: false };
      throw new SetupError("ENROLLMENT_INCOMPLETE", `OneVU did not issue a credential before the timeout. No existing vault entry or account passkey was changed by cleanup. Last page: ${lastState.slice(0, 600)}`);
    } finally {
      await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
      if (recorder?.identifier) await tab.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: recorder.identifier }).catch(() => {});
    }
  }, { keepOpen: true });
}
