import { expect, it, vi } from "vitest";
import { withCdpTab } from "./cdp-driver.js";
import { runSsoCeremony } from "./ceremony.js";
import { parseVaultPasskey } from "./ensure.js";
import { execFileSync } from "node:child_process";

// Deliberately leave the first real WebAuthn request pending in a disposable context.
// Subsequent authenticators use production options. No cookies or key bytes are logged.
let installations = 0;
const diagnostics: Record<string, unknown>[] = [];
vi.mock("./cdp-driver.js", async (original) => {
  const driver = await original<typeof import("./cdp-driver.js")>();
  const wrap: typeof driver.withCdpTab = (url, start, fn, options) => driver.withCdpTab(url, start, (tab) => fn({ ...tab,
    send: async (method, params = {}) => {
      if (method === "WebAuthn.removeVirtualAuthenticator") {
        const old = await tab.send<{credentials:{signCount:number}[]}>("WebAuthn.getCredentials", params);
        diagnostics.push({method:"preReset",counts:old.credentials.map(c=>c.signCount)});
      }
      if (method === "WebAuthn.addVirtualAuthenticator" && ++installations === 1) {
        params = { ...params, options: { ...(params.options as object), automaticPresenceSimulation: false } };
      }
      const result = await tab.send(method, params);
      if (method === "WebAuthn.addCredential") diagnostics.push({ method, count: (params.credential as {signCount:number}).signCount });
      if (method === "WebAuthn.getCredentials") diagnostics.push({ method, counts: (result as {credentials:{signCount:number}[]}).credentials.map(c=>c.signCount) });
      return result as never;
    },
  }), options);
  return { ...driver, withCdpTab: vi.fn(wrap) };
});

it.skipIf(process.env.VUTOOLKIT_LIVE !== "1")("recovers the real no-Verify-button screen and proves a fresh passkey assertion", async () => {
  installations = 0;
  diagnostics.length = 0;
  // OpenClaw's CLI skips its main entrypoint under VITEST; this is a real vault read.
  const env = { ...process.env }; delete env.VITEST;
  const secret = (name: string) => execFileSync("openclaw", ["secrets", "store", "get", name, "--plain"], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000,
  }).trim();
  const result = await runSsoCeremony({
    cdpUrl: process.env.VUTOOLKIT_CDP_URL ?? "http://127.0.0.1:18800",
    email: secret("VANDERBILT_EMAIL"),
    passkey: parseVaultPasskey(secret("VANDERBILT_PASSKEY")),
    requireAssertion: true, stepMs: 500, timeoutMs: 60_000,
  }).catch(error => { console.log(JSON.stringify({installations, diagnostics})); throw error; });
  expect(installations).toBeGreaterThan(1);
  expect(result.passkeyVerified).toBe(true);
  expect(result.assertedSignCount).toBeGreaterThan(result.signCountUsed);
  expect(vi.mocked(withCdpTab).mock.calls[0]?.[1]).toBe("about:blank");
}, 90_000);
