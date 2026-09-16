import { describe, expect, it } from "vitest";
import { classifyMicrosoftProbe } from "./liveness.js";

const AUTHORIZE = "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize";

describe("classifyMicrosoftProbe", () => {
  it("alive: the silent authorize answers with a form_post back to office.com", () => {
    const html = '<form method="POST" name="hiddenform" action="https://www.office.com/landingv2"><input type="hidden" name="code" value="x" /><input type="hidden" name="id_token" value="y" /></form>';
    expect(classifyMicrosoftProbe(200, AUTHORIZE, html)).toBe(true);
  });

  it("alive: a redirect chain that ends on the relying party", () => {
    expect(classifyMicrosoftProbe(200, "https://www.office.com/landing", "<html></html>")).toBe(true);
  });

  it("dead: the authorize URL renders the sign-in page", () => {
    const html = '<script>$Config={"urlPost":"/common/login"}</script><input name="loginfmt" type="email">';
    expect(classifyMicrosoftProbe(200, AUTHORIZE, html)).toBe(false);
  });

  it("dead: a form that posts back to the login host, or no token fields", () => {
    expect(classifyMicrosoftProbe(200, AUTHORIZE, '<form action="https://login.microsoftonline.com/kmsi"><input name="code"></form>')).toBe(false);
    expect(classifyMicrosoftProbe(200, AUTHORIZE, '<form action="https://www.office.com/landingv2"><input name="state"></form>')).toBe(false);
  });

  it("dead: non-200 answers", () => {
    expect(classifyMicrosoftProbe(400, AUTHORIZE, "")).toBe(false);
  });
});
