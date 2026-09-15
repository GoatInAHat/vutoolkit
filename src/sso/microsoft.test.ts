import { describe, expect, it } from "vitest";
import { classifyMicrosoftFlow, isMicrosoftSuccess, MicrosoftNotConfiguredError } from "./microsoft.js";

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
});

describe("MicrosoftNotConfiguredError", () => {
  it("is the credential-decision refusal, not a generic failure", () => {
    const e = new MicrosoftNotConfiguredError("needs decision");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("MicrosoftNotConfiguredError");
  });
});
