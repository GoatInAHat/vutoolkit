/**
 * The Microsoft chain (build order step 2), live-proven 2026-09-15: the managed browser's
 * persistent Entra session carries outlook.office.com with zero interactions; when it does
 * not, the identifier-first flow (email -> Next -> "Stay signed in?" -> acceptButton)
 * re-establishes it. A password prompt means the Entra session is dead and the chain needs
 * its own credential decision (design note) — refused loudly, never guessed.
 *
 * I/O honesty: same discipline as ceremony.ts — session values stay in memory, never logged
 * or echoed; errors carry no values.
 */
import type { CookieRecord } from "../vault/file-store.js";
import { CLICK_VISIBLE, FILL_NATIVE, harvestCookies, withCdpTab } from "./cdp-driver.js";

/**
 * Raised when minting is impossible without a human credential decision (dead Entra session
 * reaching a password prompt). The design note reserves that decision; nothing here guesses.
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
    host.endsWith(".outlook.office.com") ||
    host.endsWith(".outlook.office365.com")
  );
}

export type MicrosoftFlowState =
  | { kind: "success"; url: string }
  | { kind: "password"; url: string }
  | { kind: "kmsi"; url: string }
  | { kind: "identifier"; url: string }
  | { kind: "wait"; url: string };

/** Pure state machine over one page probe; the ceremony just acts on it. */
export function classifyMicrosoftFlow(probe: { url: string; loginfmt: boolean; kmsi: boolean; passwd: boolean }): MicrosoftFlowState {
  if (isMicrosoftSuccess(probe.url)) return { kind: "success", url: probe.url };
  if (probe.passwd) return { kind: "password", url: probe.url };
  if (probe.kmsi) return { kind: "kmsi", url: probe.url };
  if (probe.loginfmt) return { kind: "identifier", url: probe.url };
  return { kind: "wait", url: probe.url };
}

/**
 * Mint a Microsoft session from the browser's Entra state: direct carry when the profile
 * session is alive, identifier-first + KMSI when it needs a nudge, loud refusal at any
 * password prompt.
 */
export async function microsoftSessionFromSso(opts: MicrosoftCeremonyOptions): Promise<MintedMicrosoftSession> {
  const stepMs = opts.stepMs ?? 2000;
  const startUrl = opts.startUrl ?? "https://outlook.office.com/";
  return withCdpTab(opts.cdpUrl, startUrl, async (tab) => {
    const { evaluate, send } = tab;
    const probeExpr =
      "(() => ({ url: location.href," +
      " loginfmt: !!document.querySelector('input[name=loginfmt]')," +
      " kmsi: !!document.querySelector('#acceptButton')," +
      " passwd: !!document.querySelector('input[name=passwd]') }))()";
    let didFill = false;
    let didKmsi = false;
    let finalUrl = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 6000 : stepMs));
      const probe = (await evaluate(probeExpr).catch(() => null)) as
        | { url: string; loginfmt: boolean; kmsi: boolean; passwd: boolean }
        | null;
      if (!probe) continue;
      finalUrl = String(probe.url ?? "");
      const state = classifyMicrosoftFlow(probe);
      if (state.kind === "success") {
        const cookies = await harvestCookies(send);
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
          "microsoft mint: the Entra session is gone and the flow reached a password prompt — the chain needs its own credential decision (design note), never a guessed secret",
        );
      }
      if (state.kind === "kmsi" && !didKmsi) {
        await evaluate(`(${CLICK_VISIBLE})('#acceptButton')`);
        didKmsi = true;
        continue;
      }
      if (state.kind === "identifier" && !didFill) {
        const filled = await evaluate(`(${FILL_NATIVE})('input[name=loginfmt]', ${JSON.stringify(opts.email)})`);
        if (filled !== true) throw new Error("microsoft mint: identifier field vanished before fill");
        await new Promise((r) => setTimeout(r, 400));
        await evaluate(`(${CLICK_VISIBLE})('#idSIButton9')`);
        didFill = true;
      }
    }
    let where = "unknown";
    try {
      where = new URL(finalUrl || "about:blank").host;
    } catch { /* keep unknown */ }
    throw new Error(`microsoft mint: never reached Outlook (ended on ${where})`);
  });
}
