import { describe, expect, it } from "vitest";
import { carryMicrosoftSignIn, classifyMicrosoftFlow, isMicrosoftSuccess, MICROSOFT_PROBE_EXPR, MicrosoftNotConfiguredError, type MicrosoftProbe } from "./microsoft.js";

describe("isMicrosoftSuccess", () => {
  it("accepts the live-proven Outlook landing (2026-09-15)", () => {
    expect(isMicrosoftSuccess("https://outlook.office.com/mail/")).toBe(true);
    expect(isMicrosoftSuccess("https://outlook.office365.com/owa/")).toBe(true);
  });

  it("refuses login pages, chrome errors, and non-https", () => {
    expect(isMicrosoftSuccess("https://login.microsoftonline.com/authorize?x=1")).toBe(false);
    expect(isMicrosoftSuccess("chrome-error://chromewebdata/")).toBe(false);
    expect(isMicrosoftSuccess("http://outlook.office.com/")).toBe(false);
  });
});

describe("classifyMicrosoftFlow", () => {
  const base = { url: "https://login.microsoftonline.com/", loginfmt: false, kmsi: false, passwd: false };

  it("success wins over every other signal", () => {
    const s = classifyMicrosoftFlow({ ...base, url: "https://outlook.office.com/mail/", loginfmt: true, kmsi: true, passwd: true });
    expect(s.kind).toBe("success");
  });

  it("password means credential decision, before any clicking", () => {
    expect(classifyMicrosoftFlow({ ...base, passwd: true }).kind).toBe("password");
  });

  it("kmsi, then identifier, then wait", () => {
    expect(classifyMicrosoftFlow({ ...base, kmsi: true }).kind).toBe("kmsi");
    expect(classifyMicrosoftFlow({ ...base, loginfmt: true }).kind).toBe("identifier");
    expect(classifyMicrosoftFlow(base).kind).toBe("wait");
  });

  it("recognizes the federation hop stopping on OneVU sign-in, ahead of kmsi and identifier", () => {
    const onevu = { ...base, url: "https://onevu.vanderbilt.edu/app/office365/x/sso/wsfed/passive", okta: true };
    expect(classifyMicrosoftFlow({ ...onevu, kmsi: true, loginfmt: true }).kind).toBe("okta");
    expect(classifyMicrosoftFlow({ ...onevu, passwd: true }).kind).toBe("password");
  });

  it("recognizes the account picker after kmsi and before the identifier field", () => {
    expect(classifyMicrosoftFlow({ ...base, picker: true, loginfmt: true }).kind).toBe("picker");
    expect(classifyMicrosoftFlow({ ...base, picker: true, kmsi: true }).kind).toBe("kmsi");
  });

  it("accepts the outlook.cloud.microsoft landing", () => {
    expect(isMicrosoftSuccess("https://outlook.cloud.microsoft/mail/")).toBe(true);
  });
});

describe("MicrosoftNotConfiguredError", () => {
  it("is the credential-decision refusal, not a generic failure", () => {
    const e = new MicrosoftNotConfiguredError("needs decision");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("MicrosoftNotConfiguredError");
  });
});

describe("carryMicrosoftSignIn", () => {
  const EMAIL = "synthetic@vanderbilt.edu";
  const page = (over: Partial<MicrosoftProbe>): MicrosoftProbe => ({ url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", loginfmt: false, kmsi: false, passwd: false, ...over });

  /** A scripted page: each probe returns the next state; actions are recorded, never executed. */
  function scripted(states: MicrosoftProbe[]) {
    const actions: string[] = [];
    let i = 0;
    const evaluate = async (expr: string) => {
      if (expr === MICROSOFT_PROBE_EXPR) return states[Math.min(i++, states.length - 1)];
      actions.push(expr);
      return true;
    };
    return { evaluate, actions };
  }

  it("picks this account's tile on Outlook's account picker and returns where it lands", async () => {
    const { evaluate, actions } = scripted([page({ picker: true }), page({ kmsi: true }), page({ url: "https://outlook.cloud.microsoft/mail/" })]);
    const url = await carryMicrosoftSignIn({ evaluate, email: EMAIL, stepMs: 1 });
    expect(url).toBe("https://outlook.cloud.microsoft/mail/");
    expect(actions[0]).toContain(JSON.stringify(EMAIL));
    expect(actions).toHaveLength(2);
  });

  it("enters only the identifier, then rides OneVU federation and the trust confirmation", async () => {
    const { evaluate, actions } = scripted([
      page({ loginfmt: true }),
      page({ url: "https://onevu.vanderbilt.edu/app/office365/x/sso/wsfed/passive", onevu: true }),
      page({ url: "https://login.microsoftonline.com/login.srf", federationTrust: true }),
      page({ url: "https://outlook.cloud.microsoft/mail/0/" }),
    ]);
    await expect(carryMicrosoftSignIn({ evaluate, email: EMAIL, stepMs: 1 })).resolves.toBe("https://outlook.cloud.microsoft/mail/0/");
    expect(actions.some((a) => a.includes("loginfmt") && a.includes(EMAIL))).toBe(true);
    expect(actions.some((a) => /passwd/.test(a))).toBe(false);
  });

  it("asks for a OneVU mint when OneVU wants a sign-in", async () => {
    const { evaluate } = scripted([page({ url: "https://onevu.vanderbilt.edu/oauth2/v1/authorize", onevu: true, okta: true })]);
    await expect(carryMicrosoftSignIn({ evaluate, email: EMAIL, stepMs: 1 })).rejects.toMatchObject({ code: "OKTA_SESSION_REQUIRED" });
  });

  it("refuses a password prompt instead of guessing a credential", async () => {
    const { evaluate } = scripted([page({ passwd: true })]);
    await expect(carryMicrosoftSignIn({ evaluate, email: EMAIL, stepMs: 1 })).rejects.toBeInstanceOf(MicrosoftNotConfiguredError);
  });

  it("gives up within its bound on a page it cannot finish", async () => {
    const { evaluate } = scripted([page({})]);
    await expect(carryMicrosoftSignIn({ evaluate, email: EMAIL, stepMs: 5, timeoutMs: 30 })).rejects.toMatchObject({ code: "MICROSOFT_FLOW_CHANGED" });
  });
});
