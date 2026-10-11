import { afterEach, describe, expect, it, vi } from "vitest";
import { withCdpTab, type CdpTab } from "./cdp-driver.js";
import { runSsoCeremony } from "./ceremony.js";
import { runInNewContext } from "node:vm";
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
    const send = setup("https://onevu.vanderbilt.edu/app/UserHome", 6);
    const promise = runSsoCeremony({ cdpUrl: "http://127.0.0.1:18800", email: "synthetic@vanderbilt.edu", passkey, requireAssertion: true });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({ passkeyVerified: true, signCountUsed: 5, assertedSignCount: 6 });
    expect(vi.mocked(withCdpTab).mock.calls[0]?.[3]).toEqual({ isolated: true });
    expect(vi.mocked(withCdpTab).mock.calls[0]?.[1]).toBe("about:blank");
    expect(send.mock.calls.findIndex(([m]) => m === "WebAuthn.addCredential")).toBeLessThan(send.mock.calls.findIndex(([m]) => m === "Page.navigate"));
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

// Exact Oct 11 observed DOM: automatic verification, only recovery links, no Verify button.
// Execute the production probe against it, rather than mocking the classifier's output.
function pendingVerification(options: { recover?: boolean; heading?: string; origin?: string } = {}) {
  vi.useFakeTimers();
  const location = new URL(options.origin ?? "https://onevu.vanderbilt.edu/oauth2/v1/authorize");
  const link = { getClientRects: () => [{}], offsetParent: {}, textContent: "Verify with something else" };
  const heading = { textContent: options.heading ?? "Verify with Security Key or Biometric Authenticator" };
  const document = { querySelector: (selector: string) => selector === "h2" ? heading : selector === "[data-se=switchAuthenticator]" ? link : null };
  const send = vi.fn(async (method: string) => {
    if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "test" };
    if (method === "WebAuthn.disable" && options.recover !== false) location.href = "https://onevu.vanderbilt.edu/app/UserHome";
    if (method === "WebAuthn.getCredentials") return { credentials: [{ credentialId: passkey.credentialId, signCount: location.pathname === "/app/UserHome" ? 7 : 5 }] };
    if (method === "Storage.getCookies") return { cookies: [{ name: "idx", value: "synthetic", domain: "onevu.vanderbilt.edu" }] };
    return {};
  });
  vi.mocked(withCdpTab).mockImplementation(async (_url, _start, fn) => fn({ tabId: "test", send: send as CdpTab["send"], evaluate: async (expr) => runInNewContext(expr, { location, document }) }));
  return send;
}
describe("automatic verification without a Verify control", () => {
  const options = { cdpUrl: "http://127.0.0.1:18800", email: "synthetic@vanderbilt.edu", passkey, requireAssertion: true, stepMs: 1000, timeoutMs: 40_000 };
  it("restarts a pending document, then proves the real assertion before harvest", async () => {
    const send = pendingVerification();
    const pending = expect(runSsoCeremony(options)).resolves.toMatchObject({ passkeyVerified: true });
    await vi.runAllTimersAsync(); await pending;
    expect(send.mock.calls.filter(([method]) => method === "WebAuthn.disable")).toHaveLength(1);
    const calls = send.mock.calls.map(([method]) => method);
    const reset = calls.indexOf("WebAuthn.disable");
    expect(calls.slice(reset - 3, reset + 5)).toEqual(["Page.navigate", "WebAuthn.getCredentials", "WebAuthn.removeVirtualAuthenticator", "WebAuthn.disable", "WebAuthn.enable", "WebAuthn.addVirtualAuthenticator", "WebAuthn.addCredential", "Page.navigate"]);
    expect(send.mock.calls.findIndex(([m]) => m === "WebAuthn.getCredentials")).toBeLessThan(send.mock.calls.findIndex(([m]) => m === "Storage.getCookies"));
  });
  it("bounds recovery and never harvests a stuck verification", async () => {
    const send = pendingVerification({ recover: false });
    const pending = expect(runSsoCeremony(options)).rejects.toMatchObject({ code: "OKTA_FLOW_CHANGED" });
    await vi.runAllTimersAsync(); await pending;
    expect(send.mock.calls.filter(([method]) => method === "WebAuthn.disable")).toHaveLength(2);
    expect(send.mock.calls.some(([m]) => m === "Storage.getCookies")).toBe(false);
  });
  it.each([{ heading: "Verify with Password" }, { origin: "https://onevu.vanderbilt.edu.attacker.example/" }])("does not recover an unrelated screen %j", async (screen) => {
    const send = pendingVerification({ ...screen, recover: false });
    const pending = expect(runSsoCeremony(options)).rejects.toMatchObject({ code: "OKTA_FLOW_CHANGED" });
    await vi.runAllTimersAsync(); await pending;
    expect(send.mock.calls.some(([m]) => m === "WebAuthn.disable")).toBe(false);
  });
});
