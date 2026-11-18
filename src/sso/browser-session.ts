/**
 * Keeping a separate, agent-driven browser signed in (the Railway kit's Playwright browser).
 *
 * Two lessons from Outlook on the web (2026-11-18):
 * - Its page loads at outlook.cloud.microsoft first and only seconds later does its MSAL.js send
 *   the browser to Microsoft's sign-in page, so where a navigation "landed" is known only once
 *   the page settles.
 * - Outlook signs in with tokens its page keeps in local storage, not with cookies alone. A browser
 *   that only received the toolkit's cookies lands on Microsoft's sign-in page even while the
 *   stored session is healthy; it has to finish that sign-in itself (account tile, identifier,
 *   OneVU federation, "Stay signed in?"), which `carryMicrosoftSignIn` does with no human input.
 *   Replacing the browser's storage wholesale would throw those tokens away again, so a reload of
 *   the stored sessions keeps what the browser earned itself.
 */
import { AuthError } from "./errors.js";
import { carryMicrosoftSignIn, MicrosoftNotConfiguredError, type PageEvaluate } from "./microsoft.js";

export type BrowserIdp = "vanderbilt" | "microsoft";

/** Where a refused session sends a browser, and whose session it was. */
export const SIGN_IN_HOSTS: ReadonlyArray<{ host: string; idp: BrowserIdp }> = [
  { host: "onevu.vanderbilt.edu", idp: "vanderbilt" },
  { host: "login.microsoftonline.com", idp: "microsoft" },
  { host: "login.microsoft.com", idp: "microsoft" },
  { host: "login.live.com", idp: "microsoft" },
];

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

/** The sign-in host this URL is on, if any. */
export function signInPage(url: string | undefined): { host: string; idp: BrowserIdp } | undefined {
  const host = url ? hostOf(url) : undefined;
  return host ? SIGN_IN_HOSTS.find((s) => s.host === host) : undefined;
}

/** Microsoft 365 apps whose page signs itself in by script after it first loads. */
const SCRIPTED_SIGN_IN = ["outlook.cloud.microsoft", "outlook.office.com", "outlook.office365.com", "office.com", "microsoft365.com", "cloud.microsoft", "sharepoint.com"];

export function signsInByScript(url: string): boolean {
  const host = hostOf(url);
  return !!host && SCRIPTED_SIGN_IN.some((suffix) => host === suffix || host.endsWith("." + suffix));
}

/** An app page that has finished loading as the signed-in user (Outlook titles it "Mail - Name - Outlook"). */
export function looksSignedIn(url: string, title: string): boolean {
  return signsInByScript(url) && / - Outlook$| - Microsoft 365$|^Home \| Microsoft 365|SharePoint$/.test(title.trim()) && title.trim() !== "Outlook";
}

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: unknown[];
}

const cookieHost = (c: StorageCookie) => c.domain.replace(/^\./, "").toLowerCase();
/** The identity providers' own cookie domains: what a re-mint renews. */
const SIGN_IN_COOKIE_DOMAINS = ["onevu.vanderbilt.edu", "microsoftonline.com", "login.microsoft.com", "login.live.com"];
const isSignInCookie = (c: StorageCookie) => {
  const host = cookieHost(c);
  return SIGN_IN_COOKIE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
};
const cookieKey = (c: StorageCookie) => `${c.name}\u0000${cookieHost(c)}\u0000${c.path ?? "/"}`;

/**
 * The state to load into the browser: the sign-in hosts' cookies come from the vault (they are what
 * a re-mint renews), while every other cookie and all local storage the browser already holds stay
 * as they are, so an app's own sign-in (Outlook's tokens) survives the reload. Vault cookies for
 * other hosts fill in only what the browser does not have yet.
 */
export function mergeStorageState(current: StorageState | undefined, vault: StorageCookie[]): StorageState {
  if (!current) return { cookies: vault, origins: [] };
  const kept = current.cookies.filter((c) => !isSignInCookie(c));
  const have = new Set(kept.map(cookieKey));
  const fromVault = vault.filter((c) => isSignInCookie(c) || !have.has(cookieKey(c)));
  return { cookies: [...kept, ...fromVault], origins: current.origins ?? [] };
}

export interface BrowserDriver {
  /** Navigate and return the tool's result text (it names the page URL). */
  navigate(url: string): Promise<{ text: string; isError?: boolean }>;
  /** Evaluate an expression in the current page; null when it could not run. */
  evaluate: PageEvaluate;
  /** A fresh snapshot of the current page, in the navigate result's shape. */
  snapshot(): Promise<{ text: string; isError?: boolean }>;
  /** Re-mint the named sessions (empty: none) and load the stored sessions into the browser. */
  reload(force: BrowserIdp[]): Promise<void>;
  /** The Vanderbilt account the browser is meant to hold. */
  email(): string;
  log(message: string): void;
}

export const pageUrl = (text: string): string | undefined => /Page URL: (\S+)/.exec(text)?.[1];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SettleOptions {
  /** How long an app page may take to send the browser to sign-in. Defaults to 10 seconds. */
  settleMs?: number;
  stepMs?: number;
}

const LOCATION = "(() => ({ url: location.href, title: document.title }))()";

/**
 * Where the page is once an app that signs in by script has had time to do so: its sign-in host
 * as soon as it goes there, or the page itself once it shows as signed in or the time is up.
 */
export async function settledUrl(driver: Pick<BrowserDriver, "evaluate">, landed: string, opts: SettleOptions = {}): Promise<string> {
  if (!signsInByScript(landed) || signInPage(landed)) return landed;
  const deadline = Date.now() + (opts.settleMs ?? 10_000);
  let url = landed;
  while (Date.now() < deadline) {
    await sleep(opts.stepMs ?? 1000);
    const here = (await driver.evaluate(LOCATION).catch(() => null)) as { url?: unknown; title?: unknown } | null;
    if (!here || typeof here.url !== "string") continue;
    url = here.url;
    if (signInPage(url) || looksSignedIn(url, String(here.title ?? ""))) return url;
  }
  return url;
}

export interface NavigateOptions extends SettleOptions {
  /** Bound on finishing one Microsoft sign-in page in the browser. Defaults to 90 seconds. */
  carryMs?: number;
}

/**
 * Navigate as the student. When the site sends the browser to sign in (at once, or a few seconds
 * later by script), finish the sign-in in the background and open the page again:
 * - Microsoft: finish Microsoft's own sign-in page in this browser; when OneVU wants a sign-in on
 *   the way, mint OneVU with the toolkit passkey, load it and try once more; if the page still
 *   cannot finish, re-mint the Microsoft session itself.
 * - OneVU: re-mint the Vanderbilt session and load it.
 * At most two recoveries per call; the result is always the page the browser is on at the end.
 */
export async function navigateSignedIn(driver: BrowserDriver, url: string, opts: NavigateOptions = {}): Promise<{ text: string; isError?: boolean }> {
  let result = await driver.navigate(url);
  if (result.isError || signInPage(url)) return result;
  const open = async () => {
    const landedAt = pageUrl(result.text) ?? url;
    const settled = await settledUrl(driver, landedAt, opts);
    // The navigate result shows the page as it first loaded (for Outlook, an empty "Outlook" shell),
    // so whenever the page had time to settle, show it as it is now.
    if (settled !== landedAt || signsInByScript(landedAt)) result = await driver.snapshot();
    return settled;
  };
  let where = await open();
  for (let attempt = 0; attempt < 2; attempt++) {
    const signIn = signInPage(where);
    if (!signIn) return result;
    if (signIn.idp === "vanderbilt") {
      driver.log("browser: OneVU asked this browser to sign in; re-minting the Vanderbilt session");
      await driver.reload(["vanderbilt"]);
    } else {
      try {
        driver.log("browser: Microsoft asked this browser to sign in; finishing it in the background");
        await carryMicrosoftSignIn({ evaluate: driver.evaluate, email: driver.email(), timeoutMs: opts.carryMs ?? 90_000, isDone: (u) => !signInPage(u) });
      } catch (error) {
        if (error instanceof MicrosoftNotConfiguredError) throw error;
        const code = error instanceof AuthError ? error.code : "error";
        driver.log(`browser: Microsoft sign-in in the browser stopped (${code}); re-minting ${code === "OKTA_SESSION_REQUIRED" ? "the Vanderbilt" : "the Microsoft"} session`);
        await driver.reload([code === "OKTA_SESSION_REQUIRED" ? "vanderbilt" : "microsoft"]);
      }
    }
    result = await driver.navigate(url);
    if (result.isError) return result;
    where = await open();
  }
  return result;
}
