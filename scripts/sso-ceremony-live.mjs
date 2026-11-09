/**
 * Live ceremony evidence harness (run through `node --import tsx`).
 *
 * Mint a fresh Vanderbilt SSO session with the vaulted passkey in an isolated browser tab, then
 * prove it against the real service (aai shell liveness probe) instead of trusting the URL.
 * Prints counts and booleans only: never the email, cookies, or key material.
 */
import { execFileSync } from "node:child_process";
import { runSsoCeremony } from "../src/sso/ceremony.ts";
import { parseVaultPasskey } from "../src/sso/ensure.ts";
import { probeVanderbilt } from "../src/sso/liveness.ts";

const env = { ...process.env };
delete env.VITEST; // OpenClaw's CLI skips its entrypoint under VITEST; this is a real vault read.
const secret = (name) =>
  execFileSync("openclaw", ["secrets", "store", "get", name, "--plain"], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000,
  }).trim();

const passkey = parseVaultPasskey(secret("VANDERBILT_PASSKEY"));
try {
  const minted = await runSsoCeremony({
    cdpUrl: process.env.VUTOOLKIT_CDP_URL ?? "http://127.0.0.1:18800",
    email: secret("VANDERBILT_EMAIL"),
    passkey,
    requireAssertion: true,
    stepMs: 500,
    timeoutMs: 90_000,
  });
  const healthy = await probeVanderbilt(minted.cookies);
  console.log(JSON.stringify({
    ok: healthy && minted.passkeyVerified === true,
    passkeyVerified: minted.passkeyVerified,
    signCountUsed: minted.signCountUsed,
    assertedSignCount: minted.assertedSignCount,
    cookieCount: minted.cookies.length,
    domains: [...new Set(minted.cookies.map((c) => c.domain))].sort(),
    hasExpiry: Boolean(minted.expiresAt),
    liveProbeHealthy: healthy,
  }));
  process.exitCode = healthy && minted.passkeyVerified === true ? 0 : 1;
} catch (error) {
  // AuthError messages name the last page host/path and step counts, never values.
  console.log(JSON.stringify({
    ok: false,
    error: String(error?.name ?? "Error"),
    code: error?.code ?? null,
    retryable: Boolean(error?.retryable),
    message: String(error?.message ?? ""),
  }));
  process.exitCode = 1;
}
