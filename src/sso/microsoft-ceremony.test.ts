import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withCdpTab, type CdpTab } from "./cdp-driver.js";
import { microsoftSessionFromSso } from "./microsoft.js";

vi.mock("./cdp-driver.js", async (original) => ({ ...await original<typeof import("./cdp-driver.js")>(), withCdpTab: vi.fn() }));

// Redacted DOM shape observed at login.microsoftonline.com/login.srf on 2026-10-08.
// Execute the actual probe/click expressions so a classifier-only test cannot mask this regression.
function setup(options: {
  heading?: string; url?: string; disabled?: boolean; opacity?: string;
  label?: string; repeats?: boolean; changeBeforeClick?: boolean;
} = {}) {
  vi.useFakeTimers();
  const location = new URL(options.url ?? "https://login.microsoftonline.com/login.srf");
  let headingText = options.heading ?? "Do you trust vanderbilt.edu?";
  const click = vi.fn(() => { if (!options.repeats) location.href = "https://outlook.office.com/mail/"; });
  const element = (props = {}) => ({
    offsetParent: {}, getClientRects: () => [{}], getAttribute: () => null,
    textContent: "", value: "", disabled: false, ...props,
  });
  const heading = element();
  Object.defineProperty(heading, "textContent", { get: () => headingText });
  const button = element({ value: options.label ?? "Continue", disabled: options.disabled ?? false, click });
  const document = {
    querySelector: (selector: string) => {
      if (selector === "#loginHeader, h1, [role=heading]") return heading;
      if (selector === "#idSIButton9") return button;
      return null;
    },
    querySelectorAll: () => [],
  };
  const send = vi.fn(async () => ({ cookies: [{ name: "ESTSAUTH", value: "synthetic", domain: "login.microsoftonline.com" }] }));
  const evaluate = async (expression: string) => {
    if (options.changeBeforeClick && expression.includes("document.querySelector('#idSIButton9').click()")) headingText = "Permissions requested";
    return runInNewContext(expression, {
      location, document, getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: options.opacity ?? "1" }),
    });
  };
  vi.mocked(withCdpTab).mockImplementation(async (_url, _start, fn) => fn({ tabId: "synthetic", send: send as CdpTab["send"], evaluate }));
  return { click, send };
}

const opts = { cdpUrl: "http://127.0.0.1:18800", email: "synthetic@vanderbilt.edu", timeoutMs: 9000, stepMs: 100 };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("Microsoft federation confirmation ceremony", () => {
  it("continues the exact Vanderbilt confirmation and proves the harvested session", async () => {
    const { click, send } = setup();
    const verify = vi.fn(async () => true);
    const pending = expect(microsoftSessionFromSso({ ...opts, verify })).resolves.toMatchObject({ finalUrl: "https://outlook.office.com/mail/" });
    await vi.runAllTimersAsync();
    await pending;
    expect(click).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Storage.getCookies", {});
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it.each([
    { heading: "Do you trust attacker.example?" },
    { heading: "Do you trust vanderbilt.edu.attacker.example?" },
    { heading: "Permissions requested" },
    { url: "https://login.microsoftonline.com.attacker.example/login.srf" },
    { url: "http://login.microsoftonline.com/login.srf" },
    { disabled: true },
    { opacity: "0" },
    { label: "Accept" },
    { changeBeforeClick: true },
  ])("does not click an unrelated, unavailable or changed confirmation: %j", async (fixture) => {
    const { click, send } = setup(fixture);
    const pending = expect(microsoftSessionFromSso({ ...opts, verify: async () => true })).rejects.toMatchObject({ code: "MICROSOFT_FLOW_CHANGED" });
    await vi.runAllTimersAsync();
    await pending;
    expect(click).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds repeated confirmations", async () => {
    const { click } = setup({ repeats: true });
    const pending = expect(microsoftSessionFromSso(opts)).rejects.toMatchObject({ code: "MICROSOFT_FLOW_CHANGED", retryable: false });
    await vi.runAllTimersAsync();
    await pending;
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("does not confirm a domain for a different configured account", async () => {
    const { click } = setup();
    const pending = expect(microsoftSessionFromSso({ ...opts, email: "synthetic@example.test" })).rejects.toMatchObject({ code: "MICROSOFT_FLOW_CHANGED", retryable: false });
    await vi.runAllTimersAsync();
    await pending;
    expect(click).not.toHaveBeenCalled();
  });

  it("never treats clicking Continue or reaching the Outlook shell as proof", async () => {
    const { click } = setup();
    const verify = vi.fn(async () => false);
    const pending = expect(microsoftSessionFromSso({ ...opts, verify })).rejects.toMatchObject({ code: "MICROSOFT_FLOW_CHANGED" });
    await vi.runAllTimersAsync();
    await pending;
    expect(click).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalled();
  });
});
