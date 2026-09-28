/** Select the host's browser once, then use exactly that endpoint throughout authentication. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// A native plugin may call back into its own host; never block that host event loop.
const execFileAsync = promisify(execFile);
import { cdpReachable } from "./cdp-driver.js";
import { AuthError } from "./errors.js";

export interface BrowserSelection {
  cdpUrl: string;
  profile?: string;
  canStart: boolean;
  source: "endpoint" | "profile" | "default" | "fallback";
}
export interface BrowserConfigDeps {
  status?: (profile?: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  start?: (profile: string) => void | Promise<void>;
  reachable?: typeof cdpReachable;
  wait?: (ms: number) => Promise<void>;
}

function unavailable(message: string): AuthError {
  return new AuthError("BROWSER_UNAVAILABLE", message, { retryable: false });
}

/** Credential-bearing URLs must never be included in error messages. */
function endpoint(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw unavailable("Vutoolkit needs an HTTP(S) Chromium CDP endpoint (not a WebSocket, extension relay, or browser-control API). Set VUTOOLKIT_CDP_URL to a compatible endpoint.");
  }
}

async function status(profile?: string): Promise<Record<string, unknown>> {
  const args = ["browser", "--json", ...(profile ? ["--browser-profile", profile] : []), "status"];
  try {
    const { stdout: raw } = await execFileAsync("openclaw", args, { encoding: "utf8", timeout: 90_000 });
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw unavailable("Cannot discover the selected OpenClaw browser. Check `openclaw browser --json status`, or set VUTOOLKIT_CDP_URL to the existing authenticated Chromium browser's HTTP(S) CDP endpoint. No alternate browser was launched.");
  }
}

function selection(info: Record<string, unknown>, source: BrowserSelection["source"], requestedProfile?: string): BrowserSelection | undefined {
  if (info.enabled === false) throw unavailable("OpenClaw browser control is disabled. Enable a compatible browser or configure VUTOOLKIT_CDP_URL; no browser was launched.");
  // These adapters do not expose the full raw CDP/WebAuthn surface used by enrollment.
  if (info.driver === "extension" || info.driver === "existing-session" || typeof info.cdpUrl !== "string") return undefined;
  const cdpUrl = endpoint(info.cdpUrl);
  const hostname = new URL(cdpUrl).hostname;
  const profile = typeof info.profile === "string" ? info.profile : requestedProfile;
  return {
    cdpUrl, profile, source,
    canStart: Boolean(profile && info.driver === "openclaw" && !info.attachOnly && ["127.0.0.1", "localhost", "[::1]"].includes(hostname)),
  };
}

/** Native status resolves configured defaults and nonstandard ports without reading host secrets. */
export async function resolveBrowser(env: NodeJS.ProcessEnv = process.env, deps: BrowserConfigDeps = {}): Promise<BrowserSelection> {
  if (env.VUTOOLKIT_CDP_URL?.trim()) {
    return { cdpUrl: endpoint(env.VUTOOLKIT_CDP_URL.trim()), canStart: false, source: "endpoint" };
  }
  const profile = env.VUTOOLKIT_BROWSER_PROFILE?.trim() || undefined;
  const read = deps.status ?? status;
  const selected = selection(await read(profile), profile ? "profile" : "default", profile);
  if (selected) return selected;
  if (profile) {
    throw unavailable("The selected VUTOOLKIT_BROWSER_PROFILE does not expose full Chromium CDP/WebAuthn support. Select a managed/raw CDP profile or set VUTOOLKIT_CDP_URL. No alternate browser was launched.");
  }
  // Only an incompatible implicit default permits fallback, never an explicit profile/URL.
  const fallback = selection(await read("openclaw"), "fallback", "openclaw");
  if (fallback) return fallback;
  throw unavailable("Neither the default browser nor the managed openclaw profile exposes full Chromium CDP. Configure VUTOOLKIT_BROWSER_PROFILE or VUTOOLKIT_CDP_URL.");
}

/** Never recover an explicit/custom endpoint by launching an unrelated browser profile. */
export async function ensureBrowser(browser: BrowserSelection, deps: BrowserConfigDeps = {}): Promise<void> {
  const reachable = deps.reachable ?? cdpReachable;
  if (await reachable(browser.cdpUrl)) return;
  if (!browser.canStart || !browser.profile) {
    throw unavailable("The selected Chromium CDP endpoint is unavailable or incompatible. Restore that browser/connection and retry; an explicit, remote, or attach-only browser is never replaced by a new managed profile.");
  }
  try {
    if (deps.start) await deps.start(browser.profile);
    else await execFileAsync("openclaw", ["browser", "--browser-profile", browser.profile, "start"], { timeout: 90_000 });
  } catch { /* Readiness below remains authoritative if CLI completion failed. */ }
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < 10; i++) {
    if (await reachable(browser.cdpUrl)) return;
    await wait(500);
  }
  throw new AuthError("BROWSER_UNAVAILABLE", "The selected managed browser did not expose a compatible CDP endpoint after startup. Check its OpenClaw browser status; no alternate profile was used.", { retryable: true });
}
