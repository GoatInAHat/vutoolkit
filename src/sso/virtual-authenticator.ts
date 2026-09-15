/**
 * The high-fidelity ceremony: a real Chromium WebAuthn stack answers OneVU's challenge with the
 * vaulted credential via CDP virtual authenticator — real Okta JS, real TLS fingerprint, session
 * cookies harvested straight from the browser context. Playwright is a dynamic peer: absent at
 * rest, required only when a live ceremony runs (gated on credentials).
 */
import { createPrivateKey } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { fromB64url } from "./assertion.js";
import type { PasskeyMaterialV1 } from "./material.js";

export interface CeremonyOptions {
  material: PasskeyMaterialV1;
  startUrl: string;
  origin: string;
  headless?: boolean;
  timeoutMs?: number;
}

export interface HarvestedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

export interface HarvestedSession {
  idp: "vanderbilt";
  origin: string;
  cookies: HarvestedCookie[];
  acquiredAt: string;
}

export class CeremonyNotConfiguredError extends Error {}

// Structural types for the Playwright/CDP surfaces used here; no playwright dependency at rest.
interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}
interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
}
interface BrowserContext {
  newCDPSession(page: PageLike): Promise<CdpSession>;
  cookies(...urls: string[]): Promise<HarvestedCookie[]>;
  pages(): PageLike[];
  close(): Promise<void>;
}
interface PlaywrightLike {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options: Record<string, unknown>,
    ): Promise<BrowserContext>;
  };
}

/** Enroll the vaulted credential into a fresh CDP virtual authenticator. */
export async function installVirtualCredential(cdp: CdpSession, m: PasskeyMaterialV1): Promise<string> {
  await cdp.send("WebAuthn.enable");
  const added = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      automaticPresenceSimulation: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  })) as { authenticatorId: string };
  const pkcs8 = createPrivateKey({
    key: m.privateKeyJwk as unknown as JsonWebKey,
    format: "jwk",
  }).export({ format: "der", type: "pkcs8" });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId: added.authenticatorId,
    credential: {
      credentialId: fromB64url(m.credentialId).toString("base64"),
      rpId: m.rpId,
      privateKey: Buffer.from(pkcs8).toString("base64"),
      userHandle: fromB64url(m.userHandle).toString("base64"),
      signCount: m.signCount,
      isResidentCredential: false,
    },
  });
  return added.authenticatorId;
}

/**
 * Run the OneVU passkey ceremony end-to-end. The CDP scaffolding is complete; the OneVU page
 * driving (VUnetID fill, ceremony trigger, post-login wait) lands during live de-risk probes.
 */
export async function runSsoCeremony(opts: CeremonyOptions): Promise<HarvestedSession> {
  const spec = "playwright";
  const pw = (await import(spec).catch(() => null)) as PlaywrightLike | null;
  if (!pw)
    throw new CeremonyNotConfiguredError(
      "playwright is not installed; run pnpm add -D playwright (browsers: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers on this host)",
    );
  const context = await pw.chromium.launchPersistentContext("", {
    headless: opts.headless ?? true,
    timeout: opts.timeoutMs ?? 60_000,
  });
  try {
    const page = context.pages()[0];
    if (!page) throw new CeremonyNotConfiguredError("browser context produced no page");
    const cdp = await context.newCDPSession(page);
    await installVirtualCredential(cdp, opts.material);
    await page.goto(opts.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: opts.timeoutMs ?? 60_000,
    });
    const cookies = await context.cookies(opts.origin);
    return { idp: "vanderbilt", origin: opts.origin, cookies, acquiredAt: new Date().toISOString() };
  } finally {
    await context.close().catch(() => {});
  }
}
