/**
 * Live Microsoft ceremony evidence harness (run through `node --import tsx`).
 *
 * OneVU federation chain: with a live Okta session in the browser the Outlook carry completes
 * with no human input; without one the ceremony raises OKTA_SESSION_REQUIRED, which is the
 * designed hand-off to the passkey ceremony. Either outcome is a valid observation of the chain;
 * a Microsoft password prompt is not. Prints counts and booleans only.
 */
import { execFileSync } from "node:child_process";
import { parseVaultPasskey } from "../src/sso/ensure.ts";
import { microsoftSessionFromSso } from "../src/sso/microsoft.ts";
import { probeMicrosoft } from "../src/sso/liveness.ts";

const env = { ...process.env };
delete env.VITEST; // OpenClaw's CLI skips its entrypoint under VITEST; this is a real vault read.
const secret = (name) =>
  execFileSync("openclaw", ["secrets", "store", "get", name, "--plain"], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000,
  }).trim();

const email = secret("VANDERBILT_EMAIL");
void parseVaultPasskey; // import check only; the chain never touches key material
try {
  const minted = await microsoftSessionFromSso({
    cdpUrl: process.env.VUTOOLKIT_CDP_URL ?? "http://127.0.0.1:18800",
    email,
    stepMs: 500,
    timeoutMs: 90_000,
  });
  const healthy = await probeMicrosoft(minted.cookies);
  console.log(JSON.stringify({
    ok: healthy,
    outcome: "minted",
    cookieCount: minted.cookies.length,
    domains: [...new Set(minted.cookies.map((c) => c.domain))].sort(),
    hasExpiry: Boolean(minted.expiresAt),
    liveProbeHealthy: healthy,
  }));
  process.exitCode = healthy ? 0 : 1;
} catch (error) {
  const name = String(error?.name ?? "Error");
  // OKTA_SESSION_REQUIRED is the documented federation hand-off, not a failure of this chain.
  const handOff = name === "AuthError" && error?.code === "OKTA_SESSION_REQUIRED";
  console.log(JSON.stringify({
    ok: handOff,
    outcome: name,
    code: error?.code ?? null,
    handOffToPasskey: handOff,
    message: String(error?.message ?? ""),
  }));
  process.exitCode = handOff ? 0 : 1;
}
