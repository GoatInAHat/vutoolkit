import { afterEach, describe, expect, it, vi } from "vitest";
import { withCdpTab, type CdpTab } from "./cdp-driver.js";
import { runSsoCeremony } from "./ceremony.js";
vi.mock("./cdp-driver.js", async (original) => ({ ...await original<typeof import("./cdp-driver.js")>(), withCdpTab: vi.fn() }));
const passkey = { credentialId: "YWJj", privateKey: "synthetic", userHandle: "dXNlcg", rpId: "vanderbilt.edu", signCount: 4 };
function setup(finalUrl: string, signCount: number) {
  vi.useFakeTimers();
  const send = vi.fn(async (method: string) => {
    if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "synthetic-authenticator" };
    if (method === "WebAuthn.getCredentials") return { credentials: [{ credentialId: passkey.credentialId, signCount }] };
    if (method === "Storage.getCookies") return { cookies: [{ name: "idx", value: "synthetic", domain: "onevu.vanderbilt.edu" }] };
    return {};
  });
  vi.mocked(withCdpTab).mockImplementation(async (_url, _start, fn) => fn({ tabId: "test", send: send as CdpTab["send"], evaluate: async () => ({ url: finalUrl, identifier: false, webauthn: false, error: "" }) }));
  return send;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("new-passkey proof", () => {
  it("requires isolated context, actual credential assertion, and exact OneVU success", async () => {
    setup("https://onevu.vanderbilt.edu/app/UserHome", 6);
    const promise = runSsoCeremony({ cdpUrl: "http://127.0.0.1:18800", email: "synthetic@vanderbilt.edu", passkey, requireAssertion: true });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ passkeyVerified: true, signCountUsed: 5, assertedSignCount: 6 });
    expect(vi.mocked(withCdpTab).mock.calls[0]?.[3]).toEqual({ isolated: true });
  });
  it("rejects signed-in home without an increment beyond the injected counter", async () => {
    setup("https://onevu.vanderbilt.edu/app/UserHome", 5);
    const promise = runSsoCeremony({ cdpUrl: "http://127.0.0.1:18800", email: "synthetic@vanderbilt.edu", passkey, requireAssertion: true });
    const assertion = expect(promise).rejects.toMatchObject({ code: "OKTA_REJECTED" });
    await vi.runAllTimersAsync();
    await assertion;
  });
  it("rejects unrelated HTTPS pages even after an assertion", async () => {
    const send = setup("https://unrelated.example/app/UserHome", 6);
    const promise = runSsoCeremony({ cdpUrl: "http://127.0.0.1:18800", email: "synthetic@vanderbilt.edu", passkey, requireAssertion: true });
    const assertion = expect(promise).rejects.toMatchObject({ code: "OKTA_FLOW_CHANGED" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(send.mock.calls.some(([method]) => method === "Storage.getCookies")).toBe(false);
  });
});
