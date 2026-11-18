/**
 * The YES academic record, read live through the stored Vanderbilt session.
 *
 * Live path (verified 2026-09-15): the aai shell hands the client its own academic-record
 * fragment URL (hx-get, studentId included, so no identity is stored); the fragment arrives
 * through the OIDC dance, which sessionFetch walks with the session's cookies.
 */
import type { Transcript } from "../gpa/engine.js";
import type { CookieRecord } from "../vault/file-store.js";
import { CookieJar, sessionFetch } from "../http/session-fetch.js";
import { discoverRecordFragmentUrl, parseAaiRecord } from "./aai-record.js";

export const AAI_SHELL_URL = "https://aai.app.vanderbilt.edu/aai";

/** Posted terms plus in-progress unposted courses, with the GPAs Vanderbilt posted per term. */
export async function academicRecord(cookies: CookieRecord[], fetchImpl?: typeof fetch): Promise<Transcript> {
  const jar = new CookieJar(cookies);
  const shell = await sessionFetch({ url: AAI_SHELL_URL }, { jar, fetchImpl });
  if (shell.status !== 200) throw new Error(`aai shell fetch failed: HTTP ${shell.status} after ${shell.trace.join(" -> ")}`);
  const found = discoverRecordFragmentUrl(shell.text);
  if (!found) throw new Error("aai shell carries no academic-record hx-get URL: the page layout changed");
  const res = await sessionFetch(
    { url: new URL(found, shell.url).href, headers: { "hx-request": "true", referer: AAI_SHELL_URL } },
    { jar, fetchImpl },
  );
  if (res.status !== 200) throw new Error(`aai record fetch failed: HTTP ${res.status} after ${res.trace.join(" -> ")}`);
  return parseAaiRecord(res.text);
}
