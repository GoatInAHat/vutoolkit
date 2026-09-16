/**
 * The Microsoft chain (build order step 2). Vanderbilt's Microsoft 365 tenant is federated to
 * OneVU: login.microsoftonline.com's realm lookup for vanderbilt.edu returns NameSpaceType
 * "Federated" with a OneVU WS-Fed AuthURL (verified 2026-09-16). So the chain never needs a
 * Microsoft password. With a live Okta session in the browser, Outlook carries through
 * identifier-first, the WS-Fed hop, and "Stay signed in?" with no human input. Without one, the
 * flow lands on the OneVU sign-in page; this ceremony then raises OKTA_SESSION_REQUIRED so
 * sessions.ensure can run the passkey ceremony and carry again.
 *
 * A Microsoft password prompt should never appear for a federated account; if it does, the
 * tenant changed and the chain refuses loudly instead of guessing a credential.
 *
 * I/O honesty: same discipline as ceremony.ts — session values stay in memory, never logged
 * or echoed; errors carry no values.
 */
import type { CookieRecord } from "../vault/file-store.js";
import { CLICK_VISIBLE, FILL_NATIVE, harvestCookies, withCdpTab } from "./cdp-driver.js";
import { AuthError } from "./errors.js";
import { probeMicrosoft } from "./liveness.js";

/**
 * Raised when minting is impossible without a human credential decision (a Microsoft password
 * prompt). The design note reserves that decision; nothing here guesses.
 */
export class MicrosoftNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MicrosoftNotConfiguredError";
  }
}

export interface MicrosoftCeremonyOptions {
  /** CDP HTTP endpoint of the browser to drive, e.g. http://127.0.0.1:18800. */
  cdpUrl: string;
  /** The Microsoft identifier: the same Vanderbilt email (Entra tenant account). */
  email: string;
  startUrl?: string;
  stepMs?: number;
  /** Whole-ceremony deadline; defaults to 120 seconds. */
  timeoutMs?: number;
  /**
   * Server-side proof that harvested cookies hold a live session; defaults to the liveness probe.
   * An Outlook URL alone is not proof: from an empty profile the Outlook shell loads at
   * outlook.office.com/mail/ for seconds before its script redirects to sign-in.
   */
  verify?: (cookies: CookieRecord[]) => Promise<boolean>;
}

export interface MintedMicrosoftSession {
  cookies: Array<CookieRecord & { domain: string }>;
  acquiredAt: string;
  expiresAt?: string;
  finalUrl: string;
}

/** Success: authenticated Outlook web on a real page (live-proven 2026-09-15). */
export function isMicrosoftSuccess(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "outlook.office.com" ||
    host === "outlook.office365.com" ||
    host === "outlook.cloud.microsoft" ||
    host.endsWith(".outlook.office.com") ||
    host.endsWith(".outlook.office365.com")
  );
}

export type MicrosoftFlowState =
  | { kind: "success"; url: string }
  | { kind: "password"; url: string }
  | { kind: "okta"; url: string }
  | { kind: "kmsi"; url: string }
  | { kind: "picker"; url: string }
  | { kind: "identifier"; url: string }
  | { kind: "wait"; url: string };

export interface MicrosoftProbe {
  url: string;
  loginfmt: boolean;
  kmsi: boolean;
  passwd: boolean;
  /** The federation hop stopped on OneVU's own sign-in form (no live Okta session). */
  okta?: boolean;
  /** Microsoft's "Pick an account" tile list is showing. */
  picker?: boolean;
}

/** Pure state machine over one page probe; the ceremony just acts on it. */
export function classifyMicrosoftFlow(probe: MicrosoftProbe): MicrosoftFlowState {
  if (isMicrosoftSuccess(probe.url)) return { kind: "success", url: probe.url };
  if (probe.passwd) return { kind: "password", url: probe.url };
  if (probe.okta) return { kind: "okta", url: probe.url };
  if (probe.kmsi) return { kind: "kmsi", url: probe.url };
  if (probe.picker) return { kind: "picker", url: probe.url };
  if (probe.loginfmt) return { kind: "identifier", url: probe.url };
  return { kind: "wait", url: probe.url };
}

/**
 * Visibility, not presence. Microsoft's identifier page renders a `passwd` input from the start
 * as a laid-out, opacity-0 decoy (verified from an empty profile 2026-09-16), so both a presence
 * check and a layout check would misread every fresh sign-in as a password prompt. An input
 * counts as visible only with layout, visibility, and nonzero opacity, and the page is a password
 * prompt only when the identifier field is gone.
 */
const PROBE_EXPR =
  "(() => {" +
  " const vis = (s) => { const e = document.querySelector(s); if (!e || !(e.offsetParent || e.getClientRects().length)) return false;" +
  " const st = getComputedStyle(e); return st.visibility !== 'hidden' && parseFloat(st.opacity) > 0; };" +
  " const loginfmt = vis('input[name=loginfmt]');" +
  " const h = document.querySelector('#loginHeader, h1, [role=heading]');" +
  " const heading = h ? h.textContent.trim() : '';" +
  " return { url: location.href, loginfmt," +
  " kmsi: vis('#acceptButton') || (/stay signed in/i.test(heading) && vis('#idSIButton9'))," +
  " picker: /pick an account/i.test(heading) && document.querySelectorAll('[data-test-id]').length > 0," +
  " passwd: !loginfmt && vis('input[name=passwd]')," +
  " okta: location.hostname === 'onevu.vanderbilt.edu' && (vis('input[name=identifier]') || vis('[data-se=webauthn]'))," +
  " debug: { heading: heading.slice(0, 60), next: vis('#idSIButton9'), back: vis('#idBtn_Back') } };" +
  "})()";

/** Opt-in per-probe trace on stderr (VUTOOLKIT_DEBUG=1): page host, path, state, and control flags only. */
function traceProbe(probe: MicrosoftProbe & { debug?: unknown }, state: MicrosoftFlowState): void {
  if (!process.env.VUTOOLKIT_DEBUG) return;
  let where = "?";
  try {
    const u = new URL(probe.url);
    where = u.host + u.pathname;
  } catch { /* keep ? */ }
  process.stderr.write(`vutoolkit microsoft probe: ${state.kind} ${where} ${JSON.stringify({ loginfmt: probe.loginfmt, kmsi: probe.kmsi, passwd: probe.passwd, okta: probe.okta, ...(probe.debug as object) })}\n`);
}

/** Accept "Stay signed in?": the classic #acceptButton, or #idSIButton9 on the newer page. */
const CLICK_KMSI = `(${CLICK_VISIBLE})('#acceptButton') || (${CLICK_VISIBLE})('#idSIButton9')`;

/** Pick the tile for this account on "Pick an account"; matches on the tile's own identifier. */
const pickAccount = (email: string): string =>
  "(() => { const want = " + JSON.stringify(email.toLowerCase()) + ";" +
  " const tile = [...document.querySelectorAll('[data-test-id]')].find((t) => (t.getAttribute('data-test-id') || '').toLowerCase() === want);" +
  " if (!tile) return false; tile.click(); return true; })()";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mint a Microsoft session from the browser: direct carry when the profile's Entra session is
 * alive, identifier-first + federation + KMSI when it is not.
 */
export async function microsoftSessionFromSso(opts: MicrosoftCeremonyOptions): Promise<MintedMicrosoftSession> {
  const stepMs = opts.stepMs ?? 1500;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const startUrl = opts.startUrl ?? "https://outlook.office.com/";
  return withCdpTab(opts.cdpUrl, startUrl, async (tab) => {
    const { evaluate, send } = tab;
    const deadline = Date.now() + timeoutMs;
    const verify = opts.verify ?? ((cookies: CookieRecord[]) => probeMicrosoft(cookies));
    let identifierFills = 0;
    let kmsiClicks = 0;
    let pickerClicks = 0;
    let unverifiedLandings = 0;
    let oktaSightings = 0;
    let finalUrl = "";
    let first = true;
    while (Date.now() < deadline) {
      await sleep(first ? 4000 : stepMs);
      first = false;
      const probe = (await evaluate(PROBE_EXPR).catch(() => null)) as MicrosoftProbe | null;
      if (!probe) continue; // mid-navigation; probe again
      finalUrl = String(probe.url ?? "");
      const state = classifyMicrosoftFlow(probe);
      traceProbe(probe, state);
      oktaSightings = state.kind === "okta" ? oktaSightings + 1 : 0;
      if (state.kind === "success") {
        const cookies = await harvestCookies(send);
        if (!(await verify(cookies))) {
          unverifiedLandings++;
          continue; // the Outlook shell before its sign-in redirect; keep driving
        }
        const expiries = cookies.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
        return {
          cookies,
          acquiredAt: new Date().toISOString(),
          expiresAt: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : undefined,
          finalUrl,
        };
      }
      if (state.kind === "password") {
        throw new MicrosoftNotConfiguredError(
          "microsoft mint: Microsoft asked for a password, which a OneVU-federated account never does — the tenant's federation changed and needs Bennett's decision",
        );
      }
      if (state.kind === "okta" && oktaSightings >= 2) {
        throw new AuthError("OKTA_SESSION_REQUIRED", "Microsoft sign-in federated to OneVU, and the browser holds no live OneVU session", { retryable: true });
      }
      if (state.kind === "kmsi" && kmsiClicks < 3) {
        if ((await evaluate(CLICK_KMSI).catch(() => false)) === true) kmsiClicks++;
        continue;
      }
      if (state.kind === "picker" && pickerClicks < 2) {
        if ((await evaluate(pickAccount(opts.email)).catch(() => false)) === true) pickerClicks++;
        continue;
      }
      if (state.kind === "identifier" && identifierFills < 2) {
        const filled = await evaluate(`(${FILL_NATIVE})('input[name=loginfmt]', ${JSON.stringify(opts.email)})`).catch(() => false);
        if (filled !== true) continue;
        await sleep(400);
        if ((await evaluate(`(${CLICK_VISIBLE})('#idSIButton9')`).catch(() => false)) === true) identifierFills++;
      }
    }
    let where = "an unknown page";
    try {
      where = new URL(finalUrl).host;
    } catch { /* keep default */ }
    throw new AuthError(
      "MICROSOFT_FLOW_CHANGED",
      `Microsoft sign-in did not reach a verified Outlook session within ${Math.round(timeoutMs / 1000)}s (last host ${where}; unverified Outlook landings ${unverifiedLandings})`,
      { retryable: true },
    );
  });
}
