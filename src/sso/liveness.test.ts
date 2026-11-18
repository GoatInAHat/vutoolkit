/**
 * The Microsoft liveness probe asks Microsoft's sign-in service, with the stored cookies alone,
 * whether it would silently sign Outlook in (OpenID Connect prompt=none). Synthetic cookies only.
 */
import { describe, expect, it, vi } from "vitest";
import { microsoftSilentAuthorizeUrl, probeMicrosoft, probeSession, silentAuthorizeOutcome } from "./liveness.js";

const COOKIES = [
  { name: "ESTSAUTHPERSISTENT", value: "synthetic", domain: "login.microsoftonline.com" },
  { name: "OpenIdConnect.token.v1", value: "app", domain: "outlook.cloud.microsoft" },
];
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

describe("microsoftSilentAuthorizeUrl", () => {
  it("is a prompt=none request for Outlook's own client with a fresh PKCE challenge", () => {
    const a = new URL(microsoftSilentAuthorizeUrl());
    const b = new URL(microsoftSilentAuthorizeUrl());
    expect(a.origin).toBe("https://login.microsoftonline.com");
    expect(a.searchParams.get("prompt")).toBe("none");
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.searchParams.get("code_challenge")).not.toBe(b.searchParams.get("code_challenge"));
  });
});

describe("silentAuthorizeOutcome", () => {
  it("reads a code as alive and an error as dead, only on Outlook's redirect", () => {
    expect(silentAuthorizeOutcome("https://outlook.cloud.microsoft/mail/#code=abc&state=s")).toBe(true);
    expect(silentAuthorizeOutcome("https://outlook.cloud.microsoft/mail/#error=login_required&error_description=x")).toBe(false);
    expect(silentAuthorizeOutcome("https://outlook.cloud.microsoft/mail/#error=interaction_required")).toBe(false);
    expect(silentAuthorizeOutcome("https://evil.example/#code=abc")).toBeNull();
    expect(silentAuthorizeOutcome("/common/reprocess?ctx=1")).toBeNull();
    expect(silentAuthorizeOutcome(null)).toBeNull();
  });
});

describe("probeMicrosoft", () => {
  it("is alive when Microsoft silently issues a code, sending only its own host's cookies", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => redirect("https://outlook.cloud.microsoft/mail/#code=abc"));
    await expect(probeMicrosoft(COOKIES, fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).cookie).toBe("ESTSAUTHPERSISTENT=synthetic");
  });

  it("is dead when Microsoft answers login_required, the case Outlook turns into its sign-in page", async () => {
    const fetchImpl = async () => redirect("https://outlook.cloud.microsoft/mail/#error=login_required");
    await expect(probeMicrosoft(COOKIES, fetchImpl as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("follows Microsoft's own hops, but never leaves its sign-in host", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(redirect("/common/reprocess?ctx=1"))
      .mockResolvedValueOnce(redirect("https://outlook.cloud.microsoft/mail/#code=abc"));
    await expect(probeMicrosoft(COOKIES, fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
    expect(String(fetchImpl.mock.calls[1][0])).toBe("https://login.microsoftonline.com/common/reprocess?ctx=1");
    const away = async () => redirect("https://elsewhere.example/");
    await expect(probeMicrosoft(COOKIES, away as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("treats a sign-in page, a network failure, or no cookies as not proven alive", async () => {
    await expect(probeMicrosoft(COOKIES, (async () => new Response("<html>Sign in</html>", { status: 200 })) as unknown as typeof fetch)).resolves.toBe(false);
    await expect(probeMicrosoft(COOKIES, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).resolves.toBe(false);
    await expect(probeMicrosoft([], (async () => redirect("https://outlook.cloud.microsoft/mail/#code=a")) as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("is the probe ensure uses for Microsoft", async () => {
    const fetchImpl = async () => redirect("https://outlook.cloud.microsoft/mail/#code=abc");
    await expect(probeSession("microsoft", COOKIES, fetchImpl as unknown as typeof fetch)).resolves.toBe(true);
  });
});
