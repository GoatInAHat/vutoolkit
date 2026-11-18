/**
 * The agent's browser stays signed in: a page that a site sends to sign in, at once or seconds
 * later by script (Outlook's MSAL.js), is signed in again in the background and opened again.
 */
import { describe, expect, it, vi } from "vitest";
import { looksSignedIn, mergeStorageState, navigateSignedIn, signInPage, signsInByScript, type BrowserDriver } from "./browser-session.js";
import { MICROSOFT_PROBE_EXPR } from "./microsoft.js";

const EMAIL = "synthetic@vanderbilt.edu";
const OUTLOOK = "https://outlook.cloud.microsoft/mail/";
const AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&prompt=select_account";
const page = (url: string, title = "Outlook") => ({ text: `### Page\n- Page URL: ${url}\n- Page Title: ${title}\n` });

/** A fake browser: `pages` is what each navigation shows over time (first entry at once). */
function fakeBrowser(script: { navigations: string[][]; signInStates?: Array<Record<string, unknown>> }) {
  let nav = -1;
  let tick = 0;
  let current = "about:blank";
  const signIn = [...(script.signInStates ?? [])];
  const reloads: string[][] = [];
  const driver: BrowserDriver = {
    navigate: vi.fn(async () => {
      nav = Math.min(nav + 1, script.navigations.length - 1);
      tick = 0;
      current = script.navigations[nav][0];
      return page(current);
    }),
    snapshot: vi.fn(async () => page(current)),
    evaluate: async (expr: string) => {
      if (expr === MICROSOFT_PROBE_EXPR) {
        // The page stays in its last scripted state once the script runs out.
        const state = (signIn.length > 1 ? signIn.shift() : signIn[0]) ?? { url: current, loginfmt: false, kmsi: false, passwd: false };
        current = String(state.url);
        return state;
      }
      if (expr.includes("location.href") && expr.includes("document.title")) {
        const steps = script.navigations[nav];
        current = steps[Math.min(++tick, steps.length - 1)];
        return { url: current, title: current.startsWith(OUTLOOK) && current.endsWith("0/") ? "Mail - Synthetic - Outlook" : "Outlook" };
      }
      return true;
    },
    reload: vi.fn(async (force) => { reloads.push(force); }),
    email: () => EMAIL,
    log: () => {},
  };
  return { driver, reloads };
}

describe("signInPage / signsInByScript / looksSignedIn", () => {
  it("knows the sign-in hosts and the apps that redirect by script", () => {
    expect(signInPage(AUTHORIZE)?.idp).toBe("microsoft");
    expect(signInPage("https://onevu.vanderbilt.edu/oauth2/v1/authorize")?.idp).toBe("vanderbilt");
    expect(signInPage(OUTLOOK)).toBeUndefined();
    expect(signsInByScript(OUTLOOK)).toBe(true);
    expect(signsInByScript("https://brightspace.vanderbilt.edu/d2l/home")).toBe(false);
    expect(looksSignedIn(OUTLOOK, "Mail - Synthetic - Outlook")).toBe(true);
    expect(looksSignedIn(OUTLOOK, "Outlook")).toBe(false);
  });
});

describe("mergeStorageState", () => {
  const vault = [
    { name: "ESTSAUTH", value: "fresh", domain: "login.microsoftonline.com" },
    { name: "idx", value: "fresh", domain: "onevu.vanderbilt.edu" },
    { name: "msal.cache.encryption", value: "ceremony", domain: "outlook.cloud.microsoft" },
    { name: "d2lSessionVal", value: "vault", domain: "brightspace.vanderbilt.edu" },
  ];

  it("loads everything into an empty browser", () => {
    expect(mergeStorageState(undefined, vault)).toEqual({ cookies: vault, origins: [] });
  });

  it("renews the sign-in hosts' cookies but keeps the browser's own app sign-in and local storage", () => {
    const origins = [{ origin: "https://outlook.cloud.microsoft", localStorage: [{ name: "msal.token.keys", value: "synthetic" }] }];
    const current = {
      cookies: [
        { name: "ESTSAUTH", value: "dead", domain: "login.microsoftonline.com" },
        { name: "msal.cache.encryption", value: "browser", domain: "outlook.cloud.microsoft" },
      ],
      origins,
    };
    const merged = mergeStorageState(current, vault);
    const value = (name: string) => merged.cookies.filter((c) => c.name === name).map((c) => c.value);
    expect(value("ESTSAUTH")).toEqual(["fresh"]);
    expect(value("idx")).toEqual(["fresh"]);
    expect(value("msal.cache.encryption")).toEqual(["browser"]);
    expect(value("d2lSessionVal")).toEqual(["vault"]);
    expect(merged.origins).toBe(origins);
  });
});

describe("navigateSignedIn", () => {
  it("returns a page that stays signed in without touching the sessions", async () => {
    const { driver, reloads } = fakeBrowser({ navigations: [[OUTLOOK, `${OUTLOOK}0/`]] });
    const result = await navigateSignedIn(driver, OUTLOOK, { stepMs: 1 });
    expect(result.text).toContain(`${OUTLOOK}0/`);
    expect(reloads).toEqual([]);
    expect(driver.navigate).toHaveBeenCalledTimes(1);
  });

  it("notices Outlook's delayed redirect to sign-in, finishes it in the background and reopens the page", async () => {
    const { driver, reloads } = fakeBrowser({
      navigations: [[OUTLOOK, OUTLOOK, AUTHORIZE], [OUTLOOK, `${OUTLOOK}0/`]],
      signInStates: [
        { url: AUTHORIZE, loginfmt: false, kmsi: false, passwd: false, picker: true },
        { url: `${OUTLOOK}0/`, loginfmt: false, kmsi: false, passwd: false },
      ],
    });
    const result = await navigateSignedIn(driver, OUTLOOK, { stepMs: 1 });
    expect(result.text).toContain(`${OUTLOOK}0/`);
    expect(driver.navigate).toHaveBeenCalledTimes(2);
    expect(reloads).toEqual([]);
  });

  it("mints OneVU when the federation hop wants a sign-in, then tries again", async () => {
    const { driver, reloads } = fakeBrowser({
      navigations: [[OUTLOOK, AUTHORIZE], [OUTLOOK, `${OUTLOOK}0/`]],
      signInStates: [{ url: "https://onevu.vanderbilt.edu/oauth2/v1/authorize", loginfmt: false, kmsi: false, passwd: false, onevu: true, okta: true }],
    });
    const result = await navigateSignedIn(driver, OUTLOOK, { stepMs: 1, carryMs: 2_000 });
    expect(reloads).toEqual([["vanderbilt"]]);
    expect(result.text).toContain(`${OUTLOOK}0/`);
  });

  it("re-mints the Vanderbilt session when a page lands on OneVU sign-in", async () => {
    const brightspace = "https://brightspace.vanderbilt.edu/d2l/home";
    const { driver, reloads } = fakeBrowser({ navigations: [["https://onevu.vanderbilt.edu/oauth2/v1/authorize"], [brightspace]] });
    const result = await navigateSignedIn(driver, brightspace, { stepMs: 1 });
    expect(reloads).toEqual([["vanderbilt"]]);
    expect(result.text).toContain(brightspace);
  });

  it("stops after two recoveries and returns the page it is on", async () => {
    const { driver } = fakeBrowser({ navigations: [["https://onevu.vanderbilt.edu/oauth2/v1/authorize"]] });
    const result = await navigateSignedIn(driver, "https://brightspace.vanderbilt.edu/d2l/home", { stepMs: 1 });
    expect(driver.navigate).toHaveBeenCalledTimes(3);
    expect(result.text).toContain("onevu.vanderbilt.edu");
  });
});
