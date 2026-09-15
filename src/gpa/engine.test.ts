import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCALE,
  GpaError,
  cumulative,
  matchesPostedGpa,
  whatIf,
  type Transcript,
} from "./engine.js";
import { SYNTHETIC_TRANSCRIPT as FIXTURE } from "./fixtures.js";

describe("gpa engine (golden anchor)", () => {
  it("reproduces each term's posted GPA from posted marks", () => {
    const proj = whatIf(FIXTURE, []);
    expect(proj.terms[0]!.gpa).toBeCloseTo(3.42, 9); // 34.2 / 10
    expect(proj.terms[1]!.gpa).toBeCloseTo(2.93, 9); // 29.3 / 10
    expect(proj.cumulative).toBeCloseTo(3.175, 9); // 63.5 / 20
  });

  it("excludes non-GPA marks from credits and points", () => {
    const proj = whatIf(FIXTURE, []);
    expect(proj.terms[1]!.gpaCredits).toBe(10); // W and P excluded; unposted excluded
    expect(proj.cumulativeGpaCredits).toBe(20);
  });

  it("projects what-if grades onto posted and unposted courses", () => {
    const proj = whatIf(FIXTURE, [
      { course: "MATH 2300", grade: "A" }, // replaces B: +3 QP over 3 cr
      { course: "HIST 1350", grade: "A" }, // fills unposted: +12 QP over 3 cr
    ]);
    // HIST 1350's 3 credits JOIN the denominator once graded: (29.3 + 3 + 12) / 13
    expect(proj.terms[1]!.gpa).toBeCloseTo(44.3 / 13, 9);
    // +15 QP and +3 credits on the cumulative: (63.5 + 15) / 23
    expect(proj.cumulative).toBeCloseTo(78.5 / 23, 9);
    expect(proj.terms[1]!.changed).toBe(true);
    expect(proj.terms[0]!.changed).toBe(false);
  });

  it("rejects unknown marks and unknown courses instead of guessing", () => {
    expect(() => whatIf(FIXTURE, [{ course: "NOPE 9999", grade: "A" }])).toThrow(GpaError);
    const bad: Transcript = {
      terms: [{ term: "X", courses: [{ course: "C", credits: 3, grade: "E" }] }],
    };
    expect(() => whatIf(bad, [])).toThrow(GpaError);
  });

  it("yields null, not zero, for terms with no GPA-bearing credits", () => {
    const empty: Transcript = {
      terms: [{ term: "X", courses: [{ course: "C", credits: 2, grade: "P" }] }],
      scale: DEFAULT_SCALE,
    };
    const proj = whatIf(empty, []);
    expect(proj.terms[0]!.gpa).toBeNull();
    expect(proj.cumulative).toBeNull();
  });

  it("keeps the scale configurable (the live YES mapping is verified, not assumed)", () => {
    const plusScale: Transcript = {
      ...FIXTURE,
      scale: { points: { ...DEFAULT_SCALE.points, "B+": 3.0 }, nonGpa: DEFAULT_SCALE.nonGpa },
    };
    const proj = whatIf(plusScale, []);
    expect(proj.terms[0]!.gpa).toBeCloseTo((12 + 12 + 9) / 10, 9); // B+ re-weighted to 3.0
  });

  it("exposes the committed fixture through the verify helper", () => {
    expect(cumulative(FIXTURE)).toBeCloseTo(3.175, 9);
  });
});

describe("matchesPostedGpa", () => {
  it("accepts YES's truncated 3-decimal display (live 2026-09-15 case)", () => {
    // 2025 Spring: 26.10 / 10.50 = 2.48571..., posted 2.485 (truncated, not rounded).
    expect(matchesPostedGpa(26.1 / 10.5, 2.485)).toBe(true);
  });

  it("accepts the rounded display and exact equality", () => {
    expect(matchesPostedGpa(2.4867, 2.487)).toBe(true);
    expect(matchesPostedGpa(2.971, 2.971)).toBe(true);
  });

  it("refuses a genuinely different GPA and an empty recompute", () => {
    expect(matchesPostedGpa(2.484, 2.485)).toBe(false);
    // raw 2.4849 renders as 2.485 (rounded) or 2.484 (truncated) — 2.486 is neither.
    expect(matchesPostedGpa(2.4849, 2.486)).toBe(false);
    expect(matchesPostedGpa(null, 2.485)).toBe(false);
  });
});
