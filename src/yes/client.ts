/**
 * YES client: thin wrapper over live YES endpoints riding an injected session, with a fixture
 * mode for development and tests. Deliberately unfriendly-by-design: no re-implementations of
 * YES features that rot when routes change — the record shape is the transcript type and
 * everything else stays raw.
 */
import type { Transcript } from "../gpa/engine.js";
import { assertSafe } from "./guard.js";

export const YES_ORIGIN = "https://yes.vanderbilt.edu";

/** Set once the live academic-record endpoint is verified against real YES (gated on creds). */
export const ACADEMIC_RECORD_PATH: string | null = null;

export interface YesClientOptions {
  /** Raw Cookie header for yes.vanderbilt.edu, from the session store. */
  cookieHeader?: string;
  /** Fixture transcript for dev/test: academicRecord() returns it verbatim. */
  fixture?: Transcript;
  fetchImpl?: typeof fetch;
}

export class YesNotConfiguredError extends Error {}

export class YesClient {
  constructor(private readonly opts: YesClientOptions = {}) {}

  get fixtureMode(): boolean {
    return this.opts.fixture !== undefined;
  }

  /**
   * The student's academic record: posted terms plus in-progress unposted courses.
   * Fixture mode returns the fixture; live mode is gated until ACADEMIC_RECORD_PATH is
   * verified against the real YES API.
   */
  async academicRecord(): Promise<Transcript> {
    if (this.opts.fixture) return this.opts.fixture;
    if (!ACADEMIC_RECORD_PATH || !this.opts.cookieHeader)
      throw new YesNotConfiguredError(
        "live YES access is gated on credentials: verify ACADEMIC_RECORD_PATH against the real API, then pass a session cookie",
      );
    const res = await this.fetch(YES_ORIGIN + ACADEMIC_RECORD_PATH);
    return (await res.json()) as Transcript;
  }

  private fetch(url: string, init: RequestInit = {}): Promise<Response> {
    assertSafe(url, init.method ?? "GET");
    const impl = this.opts.fetchImpl ?? fetch;
    return impl(url, {
      ...init,
      headers: { cookie: this.opts.cookieHeader ?? "", ...(init.headers ?? {}) },
    });
  }
}
