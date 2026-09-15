/**
 * YES client: thin wrapper over the live YES endpoints riding an injected session, with a
 * fixture mode for development and tests. Deliberately unfriendly-by-design: no
 * re-implementations of YES features that rot when routes change — the record shape is the
 * transcript type and everything else stays raw.
 *
 * Live path (verified 2026-09-15): the aai shell hands the client its own academic-record
 * fragment URL (hx-get, studentId included — no hardcoded identity); the fragment arrives
 * through the OIDC dance, which jarFetch walks with the session's cookies.
 */
import type { Transcript } from "../gpa/engine.js";
import type { CookieRecord } from "../vault/file-store.js";
import { assertSafe } from "./guard.js";
import { CookieJar, jarFetch } from "./jar.js";
import { discoverRecordFragmentUrl, parseAaiRecord } from "./aai-record.js";

export const AAI_ORIGIN = "https://aai.app.vanderbilt.edu";
/** The aai shell page; its hx-get attributes name the record fragment (studentId included). */
export const AAI_SHELL_PATH = "/aai";
/** Verified live: the HTMX academic-record fragment (requires HX-Request + a danced session). */
export const ACADEMIC_RECORD_PATH = "/aai/academic-record/academic-record";

export interface YesClientOptions {
  /** Stored vanderbilt session cookies (from the vault), scoped per-domain for the jar. */
  cookies?: CookieRecord[];
  /** Fixture transcript for dev/test: academicRecord() returns it verbatim. */
  fixture?: Transcript;
  fetchImpl?: typeof fetch;
  /** Optional override; the shell normally self-configures via its hx-get URL. */
  recordUrl?: string;
}

export class YesNotConfiguredError extends Error {}

export class YesClient {
  constructor(private readonly opts: YesClientOptions = {}) {}

  get fixtureMode(): boolean {
    return this.opts.fixture !== undefined;
  }

  /**
   * The student's academic record: posted terms plus in-progress unposted courses, as one
   * chronological transcript with the GPAs Vanderbilt posted per term. Fixture mode returns
   * the fixture; live mode rides the injected session through the dance and parses the
   * fragment.
   */
  async academicRecord(): Promise<Transcript> {
    if (this.opts.fixture) return this.opts.fixture;
    if (!this.opts.cookies || this.opts.cookies.length === 0) {
      throw new YesNotConfiguredError(
        "live YES access needs a vanderbilt session: pass cookies from the vault (record.fetch mints one automatically when the vault is empty)",
      );
    }
    const fragmentUrl = await this.recordFragmentUrl();
    const jar = new CookieJar(this.opts.cookies);
    const res = await jarFetch(fragmentUrl, {
      jar,
      headers: { "hx-request": "true", referer: AAI_ORIGIN + AAI_SHELL_PATH },
      fetchImpl: this.opts.fetchImpl,
    });
    if (res.status !== 200) {
      throw new Error(`aai record fetch failed: HTTP ${res.status} after ${res.trace.join(" -> ")}`);
    }
    return parseAaiRecord(res.text);
  }

  /** Explicit override, else the shell's own hx-get URL (self-configuring, no stored identity). */
  private async recordFragmentUrl(): Promise<string> {
    if (this.opts.recordUrl) return this.opts.recordUrl;
    const shellUrl = AAI_ORIGIN + AAI_SHELL_PATH;
    assertSafe(shellUrl, "GET");
    const jar = new CookieJar(this.opts.cookies ?? []);
    const res = await jarFetch(shellUrl, { jar, fetchImpl: this.opts.fetchImpl });
    if (res.status !== 200) {
      throw new Error(`aai shell fetch failed: HTTP ${res.status} after ${res.trace.join(" -> ")}`);
    }
    const found = discoverRecordFragmentUrl(res.text);
    if (!found) throw new Error("aai shell carries no academic-record hx-get URL — layout changed");
    return new URL(found, res.finalUrl).href;
  }
}
