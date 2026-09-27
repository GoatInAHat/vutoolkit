/**
 * Pure GPA engine: configuration-driven scale, no I/O. This module is the golden anchor of
 * vutoolkit — gpa.verify replays it against Vanderbilt's posted numbers before any what-if
 * output is trusted, so every semantic decision (which grades count, how credits aggregate)
 * lives here and nowhere else.
 */

export interface GradeScale {
  /** GPA-bearing marks mapped to quality points per credit hour. */
  points: Record<string, number>;
  /** Marks that carry credits on the transcript but no GPA weight (P/W/I/AU/...). */
  nonGpa: readonly string[];
}

/** Conventional US 4.0 scale; the live YES mapping is locked in by gpa.verify, not assumed. */
export const DEFAULT_SCALE: GradeScale = {
  points: {
    A: 4, "A-": 3.7, "B+": 3.3, B: 3, "B-": 2.7,
    "C+": 2.3, C: 2, "C-": 1.7, "D+": 1.3, D: 1, "D-": 0.7, F: 0,
  },
  nonGpa: ["P", "W", "I", "AU", "IP", "NR"],
};

export interface CourseRecord {
  course: string;
  credits: number;
  /** Institution-posted GPA hours, when different from earned/enrolled credits (e.g. repeats). */
  gpaCredits?: number;
  /** Posted letter mark, or undefined while unposted (what-if fills these). */
  grade?: string;
}

export interface TermRecord {
  term: string;
  courses: CourseRecord[];
  /** The GPA Vanderbilt itself posted for this term — the golden anchor. */
  postedGpa?: number;
}

export interface Transcript {
  terms: TermRecord[];
  /** Latest cumulative GPA posted by YES, independent of the engine's recomputation. */
  postedCumulativeGpa?: number;
  scale?: GradeScale;
}

export interface HypotheticalGrade {
  course: string;
  grade: string;
  /** Disambiguates multiple attempts of the same course. */
  term?: string;
}

export interface TermProjection {
  term: string;
  gpa: number | null;
  gpaCredits: number;
  qualityPoints: number;
  changed: boolean;
}

export interface WhatIfProjection {
  terms: TermProjection[];
  cumulative: number | null;
  cumulativeGpaCredits: number;
  cumulativeQualityPoints: number;
}

export class GpaError extends Error {}

function scaleOf(transcript: Transcript): GradeScale {
  return transcript.scale ?? DEFAULT_SCALE;
}

function graded(terms: TermRecord[], scale: GradeScale): CourseRecord[] {
  const out: CourseRecord[] = [];
  for (const t of terms) for (const c of t.courses) if (c.grade !== undefined) out.push(c);
  return out;
}

/**
 * Is this course GPA-bearing? Strict: a posted mark must be in the scale's points or its
 * explicit nonGpa list — anything else is an error, never a silent skip. Silent exclusion of
 * unknown marks would corrupt every downstream GPA.
 */
function gpaBearing(c: CourseRecord, scale: GradeScale): boolean {
  if (c.grade === undefined || c.gpaCredits === 0 || scale.nonGpa.includes(c.grade)) return false;
  if (!(c.grade in scale.points)) throw new GpaError(`unknown grade mark '${c.grade}' on ${c.course}`);
  return true;
}

export function gpaCredits(courses: CourseRecord[], scale: GradeScale = DEFAULT_SCALE): number {
  return courses.filter((c) => gpaBearing(c, scale)).reduce((sum, c) => sum + (c.gpaCredits ?? c.credits), 0);
}

export function qualityPoints(courses: CourseRecord[], scale: GradeScale = DEFAULT_SCALE): number {
  return courses
    .filter((c) => gpaBearing(c, scale))
    .reduce((sum, c) => sum + (c.gpaCredits ?? c.credits) * scale.points[c.grade!]!, 0);
}

export function gpa(courses: CourseRecord[], scale: GradeScale = DEFAULT_SCALE): number | null {
  const credits = gpaCredits(courses, scale);
  return credits > 0 ? qualityPoints(courses, scale) / credits : null;
}

/** Apply what-if grades onto a transcript: replaces posted grades and fills unposted ones. */
function withHypotheticals(transcript: Transcript, hypotheticals: HypotheticalGrade[]): Transcript {
  const byCourse = new Map(hypotheticals.map((h) => [h.course, h.grade]));
  const terms = transcript.terms.map((t) => ({
    ...t,
    courses: t.courses.map((c) => (byCourse.has(c.course) ? { ...c, grade: byCourse.get(c.course) } : c)),
  }));
  return { ...transcript, terms };
}

export function whatIf(transcript: Transcript, hypotheticals: HypotheticalGrade[]): WhatIfProjection {
  const scale = scaleOf(transcript);
  const adjusted = withHypotheticals(transcript, hypotheticals);
  const known = new Set(transcript.terms.flatMap((t) => t.courses.map((c) => c.course)));
  for (const h of hypotheticals)
    if (!known.has(h.course)) throw new GpaError(`hypothetical for unknown course ${h.course}`);
  const terms: TermProjection[] = adjusted.terms.map((t, i) => {
    const before = transcript.terms[i]!;
    return {
      term: t.term,
      gpa: gpa(t.courses, scale),
      gpaCredits: gpaCredits(t.courses, scale),
      qualityPoints: qualityPoints(t.courses, scale),
      changed: gpa(t.courses, scale) !== gpa(before.courses, scale),
    };
  });
  const all = graded(adjusted.terms, scale);
  return {
    terms,
    cumulative: gpa(all, scale),
    cumulativeGpaCredits: gpaCredits(all, scale),
    cumulativeQualityPoints: qualityPoints(all, scale),
  };
}

/** Cumulative GPA across all graded coursework in the transcript. */
export function cumulative(transcript: Transcript): number | null {
  const scale = scaleOf(transcript);
  return gpa(graded(transcript.terms, scale), scale);
}

export function round3(n: number | null): number | null {
  return n === null ? null : Math.round(n * 1000) / 1000;
}

/**
 * Does the engine's recomputed term GPA reproduce what YES posted? YES displays GPAs
 * truncated to 3 decimals (live 2026-09-15: 26.10/10.50 = 2.48571..., posted 2.485), so the
 * truncated and rounded 3-decimal renderings both count as exact reproductions — neither is a
 * tolerance, and a real scale error moves the GPA far more than one display step.
 */
export function matchesPostedGpa(raw: number | null, posted: number): boolean {
  if (raw === null) return false;
  const rounded = round3(raw);
  const truncated = Math.floor(raw * 1000) / 1000;
  return rounded === posted || truncated === posted;
}

/** Verify independent posted totals; never substitute a recomputation for a missing anchor. */
export function verifyTranscript(transcript: Transcript) {
  const projection = whatIf(transcript, []);
  const rows = transcript.terms.flatMap((term, index) => {
    if (term.postedGpa === undefined) return [];
    const raw = projection.terms[index]?.gpa ?? null;
    return [{ term: term.term, posted: term.postedGpa, recomputed: round3(raw), match: matchesPostedGpa(raw, term.postedGpa) }];
  });
  const cumulativeCheck = {
    posted: transcript.postedCumulativeGpa ?? null,
    recomputed: round3(projection.cumulative),
    match: transcript.postedCumulativeGpa === undefined
      ? null
      : matchesPostedGpa(projection.cumulative, transcript.postedCumulativeGpa),
  };
  const ok = rows.length > 0 && rows.every((row) => row.match) && cumulativeCheck.match !== false;
  return {
    ok,
    rows,
    cumulative: cumulativeCheck.recomputed,
    cumulativeCheck,
    note: !ok
      ? "MISMATCH or no posted term anchors: do not trust what-if output until the record and grade scale are verified"
      : cumulativeCheck.match === null
        ? "all posted term GPAs reproduced; cumulative GPA is unverified because no posted cumulative anchor was supplied"
        : "all posted term and cumulative GPAs reproduced",
  };
}
