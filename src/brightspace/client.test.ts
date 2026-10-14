import { describe, expect, it } from "vitest";
import {
  BRIGHTSPACE_ORIGIN,
  BrightspaceClient,
  BrightspaceNotConfiguredError,
  pageTitle,
  samlAutoPost,
  stripHtml,
} from "./client.js";

const SAML_PAGE = `<!doctype html><html><body onload="document.forms[0].submit()">
<form action="https://brightspace.vanderbilt.edu/d2l/shibbolethSSO" method="post">
<input type="hidden" name="RelayState" value="/d2l/home"/>
<input type="hidden" name="SAMLResponse" value="PHNhbWw+"/></form></body></html>`;

const CONTENT_PAGE = `<!doctype html><html><head><title>My Home - Brightspace</title></head>
<body><script>var x=1;</script><style>.a{color:red}</style><h1>Welcome</h1><p>CS&nbsp;2281 &amp; more</p></body></html>`;

describe("samlAutoPost", () => {
  it("detects a SAML POST binding form and resolves its action", () => {
    const post = samlAutoPost(SAML_PAGE, BRIGHTSPACE_ORIGIN + "/d2l/login");
    expect(post).not.toBeNull();
    expect(post?.action).toBe("https://brightspace.vanderbilt.edu/d2l/shibbolethSSO");
    expect(post?.fields.SAMLResponse).toBe("PHNhbWw+");
    expect(post?.fields.RelayState).toBe("/d2l/home");
  });

  it("returns null when the page carries no SAMLResponse", () => {
    expect(samlAutoPost(CONTENT_PAGE, BRIGHTSPACE_ORIGIN)).toBeNull();
  });
});

describe("stripHtml/pageTitle", () => {
  it("strips scripts, styles and tags; decodes entities", () => {
    expect(stripHtml(CONTENT_PAGE, 400)).toBe("My Home - Brightspace Welcome CS 2281 & more");
  });

  it("extracts the page title", () => {
    expect(pageTitle(CONTENT_PAGE)).toBe("My Home - Brightspace");
  });
});

describe("fetchPage guards", () => {
  it("refuses live access without vaulted cookies", async () => {
    await expect(new BrightspaceClient({}).fetchPage("/d2l/home")).rejects.toThrow(BrightspaceNotConfiguredError);
  });

  it("refuses paths that leave brightspace.vanderbilt.edu", async () => {
    const c = new BrightspaceClient({ cookies: [{ name: "a", value: "b", domain: "vanderbilt.edu" }] });
    await expect(c.fetchPage("https://evil.example.com/x")).rejects.toThrow(/does not stay on/);
  });
});

