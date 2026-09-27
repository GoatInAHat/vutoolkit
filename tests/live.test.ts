/**
 * Tool Factory T4: actual read-only calls using this host's existing account and vault.
 * `npm run test:live` opts in; `npm test` skips the suite. Missing auth is a failure, never
 * a fixture fallback. Hosted CI intentionally has no account/vault and runs the other tiers.
 * Only assertions and counts reach the reporter: no transcript, email, cookie or token values.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operations } from "../src/ops.js";
import { context } from "../src/toolfactory/config.js";
import { defaultSecretsRead } from "../src/sso/ensure.js";
import type { Transcript } from "../src/gpa/engine.js";

// tf:live-guard
const CREDENTIALS = ["VUTOOLKIT_LIVE"];
const live = CREDENTIALS.every((name) => process.env[name]);
// /tf:live-guard

describe.skipIf(!live)("vutoolkit against the real service", () => {
  const ctx = context();
  let record: Promise<Transcript> | undefined;
  const vitestMarker = process.env.VITEST;
  beforeAll(() => {
    // OpenClaw suppresses its CLI main when VITEST is inherited. These are deliberately
    // real host subprocesses, not test doubles; keep that harness marker out of their env.
    delete process.env.VITEST;
  });
  afterAll(() => {
    if (vitestMarker === undefined) delete process.env.VITEST;
    else process.env.VITEST = vitestMarker;
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const operation = operations.find((candidate) => candidate.name === name);
    if (!operation) throw new Error(`live operation missing: ${name}`);
    try {
      const parsed = operation.input.parse(args);
      const result = await operation.handler(parsed as never, ctx);
      return operation.output.parse(result);
    } catch (error) {
      // Live upstream errors may quote a URL or input. Keep diagnostic classes, never values.
      const kind = error instanceof Error ? error.name : "UnknownError";
      throw new Error(`${name} failed (${kind}); inspect locally with private diagnostics`);
    }
  }

  const transcript = (): Promise<Transcript> => record ??= call("record.fetch").then((result) => {
    expect(result.source === "live", "record must come from YES, not a fixture").toBe(true);
    return result.transcript;
  });

  for (const idp of ["vanderbilt", "microsoft"]) {
    it(`validates the real ${idp} session`, async () => {
      const result = await call("sessions.ensure", { idp });
      expect(result.healthy === true).toBe(true);
      expect(result.idp === idp).toBe(true);
    }, 420_000);
  }

  it("Microsoft Graph resolves the configured Vanderbilt identity", async () => {
    const expected = process.env.VUTOOLKIT_VU_EMAIL || defaultSecretsRead("VANDERBILT_EMAIL");
    const result = await call("graph.call", { method: "GET", path: "/me", query: { "$select": "id,mail,userPrincipalName" } });
    expect(result.status === 200).toBe(true);
    expect(typeof result.data?.id === "string").toBe(true);
    const identities = [result.data?.mail, result.data?.userPrincipalName]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.toLowerCase());
    expect(identities.includes(expected.toLowerCase()), "live identity matches the configured account").toBe(true);
  }, 420_000);

  it("fetches the real academic record with independent posted totals", async () => {
    const result = await transcript();
    expect(result.terms.length > 0).toBe(true);
    expect(result.terms.some((term) => term.courses.length > 0)).toBe(true);
    expect(result.terms.some((term) => term.postedGpa !== undefined)).toBe(true);
    expect(typeof result.postedCumulativeGpa === "number").toBe(true);
  }, 420_000);

  it("reproduces every posted term GPA and the posted cumulative GPA", async () => {
    const result = await call("gpa.verify", { transcript: await transcript() });
    expect(result.rows.length > 0).toBe(true);
    expect(result.rows.every((row: { match: boolean }) => row.match)).toBe(true);
    expect(result.cumulativeCheck.match === true).toBe(true);
    expect(result.ok === true).toBe(true);
  }, 420_000);

  it("projects the real in-progress courses without modifying the record", async () => {
    const source = await transcript();
    const before = JSON.stringify(source);
    const hypotheticals = source.terms.flatMap((term) => term.courses)
      .filter((course) => course.grade === undefined)
      .map((course) => ({ course: course.course, grade: "A" }));
    const baseline = await call("grades.whatif", { transcript: source });
    const result = await call("grades.whatif", { transcript: source, hypotheticals });
    expect(Number.isFinite(result.cumulative)).toBe(true);
    expect(result.cumulative >= 0 && result.cumulative <= 4).toBe(true);
    expect(result.cumulativeGpaCredits >= baseline.cumulativeGpaCredits).toBe(true);
    expect(JSON.stringify(source) === before, "what-if never mutates the real source").toBe(true);
  }, 420_000);

  it("exports valid session injection shapes without logging their values", async () => {
    for (const idp of ["vanderbilt", "microsoft"]) {
      const header = await call("sessions.open", { idp, format: "cookie-header" });
      expect(typeof header.payload === "string" && header.payload.includes("=")).toBe(true);
      const cdp = await call("sessions.open", { idp, format: "cdp" });
      expect(Array.isArray(cdp.payload) && cdp.payload.length > 0).toBe(true);
      const state = await call("sessions.open", { idp, format: "storage-state" });
      expect(Array.isArray(state.payload?.cookies) && state.payload.cookies.length > 0).toBe(true);
    }
  }, 420_000);

  it("validates setup and the actual OneVU enrollment page without issuing a new key", async () => {
    const status = await call("setup.status");
    expect(status.readyForAuth === true).toBe(true);
    expect(status.passkeyValid === true).toBe(true);
    const prepared = await call("setup.prepare", { keepTab: false });
    expect(prepared.status === "ready").toBe(true);
    expect(prepared.enrollmentAvailable === true).toBe(true);
    expect(prepared.existingPasskeyPreserved === true).toBe(true);
  }, 420_000);
});
