/** OneVU's real self-service enrollment, with credential material confined to CDP and the vault. */
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { cdpReachable, withCdpTab, type CdpTab } from "./cdp-driver.js";
import { toCdpB64, type VaultPasskey } from "./ceremony.js";
import { defaultEnsureBrowser, defaultSecretsRead, parseVaultPasskey } from "./ensure.js";

export const SETTINGS_URL = "https://onevu.vanderbilt.edu/account-settings/security";
const SECRET_NAME = "VANDERBILT_PASSKEY";
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
    super(message);
    this.name = "SetupError";
  }
}

function readOptional(name: string, deps: SetupDeps): string | undefined {
  try { return (deps.read ?? defaultSecretsRead)(name) || undefined; } catch { return undefined; }
}

function credentials(deps: SetupDeps) {
  const env = deps.env ?? process.env;
  const email = env.VUTOOLKIT_VU_EMAIL || readOptional("VANDERBILT_EMAIL", deps);
  const vunetId = env.VUTOOLKIT_VUNETID || readOptional("VANDERBILT_VUNETID", deps);
  const raw = env.VUTOOLKIT_PASSKEY_JSON || readOptional(SECRET_NAME, deps);
  let passkey: VaultPasskey | undefined;
  if (raw) {
    try { passkey = validateCredential(parseVaultPasskey(raw)); } catch { /* status only */ }
  }
  return { email, vunetId, raw, passkey, cdpUrl: env.VUTOOLKIT_CDP_URL || "http://127.0.0.1:18800" };
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

/** Non-sensitive status; a valid existing key is never rotated merely to complete setup. */
export async function setupStatus(deps: SetupDeps = {}) {
  const auth = credentials(deps);
  return {
    identityConfigured: Boolean(auth.email || auth.vunetId),
    emailConfigured: Boolean(auth.email),
    passkeyConfigured: Boolean(auth.raw),
    passkeyValid: Boolean(auth.passkey),
    browserAvailable: await (deps.reachable ?? cdpReachable)(auth.cdpUrl),
    readyForAuth: Boolean(auth.email && auth.passkey),
    authenticated: false as const,
    settingsUrl: SETTINGS_URL,
    nextStep: auth.email && auth.passkey
      ? "Already configured. Use sessions.ensure to validate live sign-in; enrollment is unnecessary."
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
  if (vunetId) write("VANDERBILT_VUNETID", vunetId);
  return { identityConfigured: true, emailConfigured: true, vunetIdConfigured: Boolean(vunetId || auth.vunetId), emailDerivedFromVunetId: !options.email };
}

interface SecurityPage {
  authenticated: boolean;
  enrollmentAvailable: boolean;
  enrolledCount: number;
  signInRequired: boolean;
}

// The headings are matched in browser memory; no account names, key nicknames or phone data return.
const PAGE_PROBE = `(() => {
  const correctOrigin = location.origin === 'https://onevu.vanderbilt.edu';
  const section = [...document.querySelectorAll('[data-se="enrolled-authenticator-container"]')]
    .find(e => /Security Key or Biometric|Passkey/i.test(e.querySelector('[data-se="enrolled-authenticator-title"]')?.textContent || ''));
  return {
    authenticated: correctOrigin && location.pathname === '/account-settings/security',
    enrollmentAvailable: !!section?.querySelector('[data-se="setup-new-enrollment-button"]'),
    enrolledCount: section?.querySelectorAll('[data-se="enrolled-authenticator"]').length || 0,
    signInRequired: correctOrigin && !location.pathname.startsWith('/account-settings/')
  };
})()`;

async function authenticator(tab: CdpTab, passkey?: VaultPasskey): Promise<string> {
  await tab.send("WebAuthn.enable");
  const created = await tab.send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  if (passkey) await tab.send("WebAuthn.addCredential", {
    authenticatorId: created.authenticatorId,
    credential: { ...passkey, credentialId: toCdpB64(passkey.credentialId), privateKey: toCdpB64(passkey.privateKey), userHandle: toCdpB64(passkey.userHandle), isResidentCredential: passkey.isResidentCredential ?? false },
  });
  return created.authenticatorId;
}

async function waitForPage(tab: CdpTab, deps: SetupDeps): Promise<SecurityPage> {
  let last: SecurityPage = { authenticated: false, enrollmentAvailable: false, enrolledCount: 0, signInRequired: false };
  for (let n = 0; n < 12; n++) {
    await (deps.wait ?? sleep)(1000);
    const result = await tab.evaluate(PAGE_PROBE).catch(() => null) as SecurityPage | null;
    if (result) last = result;
    if (last.authenticated && last.enrollmentAvailable) break;
  }
  return last;
}

export async function prepareSetup(options: { keepTab?: boolean } = {}, deps: SetupDeps = {}) {
  const auth = credentials(deps);
  await (deps.browserReady ?? defaultEnsureBrowser)(auth.cdpUrl);
  return (deps.tab ?? withCdpTab)(auth.cdpUrl, SETTINGS_URL, async (tab) => {
    let authenticatorId: string | undefined;
    try {
      if (auth.passkey) authenticatorId = await authenticator(tab, auth.passkey);
      const page = await waitForPage(tab, deps);
      return {
        status: page.authenticated && page.enrollmentAvailable ? "ready" as const : "sign-in-required" as const,
        settingsUrl: SETTINGS_URL,
        ...(options.keepTab === false ? {} : { browserTabId: tab.tabId }),
        existingPasskeyPreserved: Boolean(auth.raw),
        enrollmentAvailable: page.enrollmentAvailable,
        nextStep: auth.passkey
          ? "Your existing toolkit passkey is preserved. No new enrollment is necessary."
          : page.authenticated && page.enrollmentAvailable
            ? "OneVU is ready. Explicitly confirm setup.enroll to create and vault the toolkit passkey."
            : "Complete OneVU sign-in in this managed browser tab, using your existing sign-in method. Never send passwords or verification codes in chat. Then run setup.prepare again.",
      };
    } finally {
      if (authenticatorId) await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    }
  }, { keepOpen: options.keepTab !== false });
}

export async function enrollSetup(options: { confirm: boolean; timeoutSeconds?: number }, deps: SetupDeps = {}) {
  if (options.confirm !== true) throw new SetupError("CONFIRMATION_REQUIRED", "Creating an account passkey requires explicit confirmation.");
  const auth = credentials(deps);
  if (auth.raw) throw new SetupError("EXISTING_PASSKEY", "A passkey entry already exists. It has not been overwritten, rotated or revoked; use setup.status and sessions.ensure.");
  if (!auth.email) throw new SetupError("IDENTITY_REQUIRED", "Configure your Vanderbilt email before enrolling a toolkit passkey.");
  await (deps.browserReady ?? defaultEnsureBrowser)(auth.cdpUrl);
  return (deps.tab ?? withCdpTab)(auth.cdpUrl, SETTINGS_URL, async (tab) => {
    const initial = await waitForPage(tab, deps);
    if (!initial.authenticated || !initial.enrollmentAvailable) throw new SetupError("SIGN_IN_REQUIRED", "Use setup.prepare and complete OneVU sign-in first; no enrollment was attempted.");
    const authenticatorId = await authenticator(tab);
    let saved = false;
    try {
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
        const result = await tab.send<{ credentials: Array<VaultPasskey> }>("WebAuthn.getCredentials", { authenticatorId });
        if (!saved && result.credentials.length > 0) {
          if (result.credentials.length !== 1) throw new SetupError("AMBIGUOUS_CREDENTIAL", "Enrollment produced multiple credentials; no entry was overwritten.");
          const material = validateCredential(result.credentials[0]!);
          if (readOptional(SECRET_NAME, deps)) throw new SetupError("EXISTING_PASSKEY", "A passkey entry appeared during setup; it has not been overwritten.");
          const serialized = JSON.stringify(material);
          (deps.write ?? writeVault)(SECRET_NAME, serialized);
          const verified = readOptional(SECRET_NAME, deps);
          if (!verified || parseVaultPasskey(verified).credentialId !== material.credentialId || parseVaultPasskey(verified).privateKey !== material.privateKey)
            throw new SetupError("VAULT_VERIFY_FAILED", "Vault readback did not confirm the new credential. The browser enrollment was not reported as complete.");
          saved = true;
        }
        const page = await tab.evaluate(PAGE_PROBE).catch(() => null) as SecurityPage | null;
        if (saved && page?.authenticated && page.enrolledCount > initial.enrolledCount)
          return { status: "enrolled" as const, secretName: SECRET_NAME, serverConfirmed: true, existingPasskeysRevoked: false };
        // Only a single enrollment-screen submit is eligible; never select a different factor.
        await tab.evaluate(`(() => {
          if (location.origin !== 'https://onevu.vanderbilt.edu' || location.pathname.startsWith('/account-settings/')) return false;
          const heading = document.querySelector('[data-se="o-form-head"]')?.textContent || '';
          if (!/Security Key or Biometric|Passkey/i.test(heading)) return false;
          const choices = [...document.querySelectorAll('input[type="submit"],button[type="submit"]')]
            .filter(e => /^(Set up|Enroll|Register|Continue|Create)$/i.test((e.value || e.textContent || '').trim()));
          if (choices.length !== 1) return false; choices[0].click(); return true;
        })()`).catch(() => false);
      }
      if (saved) return { status: "stored-awaiting-confirmation" as const, secretName: SECRET_NAME, serverConfirmed: false, existingPasskeysRevoked: false };
      throw new SetupError("ENROLLMENT_INCOMPLETE", "OneVU did not issue a credential before the timeout. No existing vault entry or account passkey was changed by cleanup.");
    } finally {
      await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }).catch(() => {});
    }
  });
}
