/**
 * Parser for the YES "Academic Record" HTMX fragment (aai.app.vanderbilt.edu), verified live
 * 2026-09-15. Pure function of the HTML: one course table per term, newest first; the term
 * label is the last heading before each table; the posted term GPA rides the "Term Totals"
 * row; in-progress courses carry credits in the "VU In Prgrs" column and no grade. Title cells
 * embed HTML comment artifacts, so comments are stripped before tags. Tolerant of attribute
 * churn, strict about the cells it maps.
 */
import type { CourseRecord, TermRecord, Transcript } from "../gpa/engine.js";

function stripHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowCells(row: string): string[] {
  return [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => stripHtml(m[1]));
}

function num(value: string | undefined): number {
  const n = Number.parseFloat((value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

interface CourseTable {
  label: string;
  rows: string[][];
}

/** Course tables are recognized by their "Course Title" header; the term label precedes them. */
function courseTables(html: string): CourseTable[] {
  const out: CourseTable[] = [];
  for (const match of html.matchAll(/<table[\s\S]*?<\/table>/g)) {
    const table = match[0];
    const firstRow = /<tr[^>]*>([\s\S]*?)<\/tr>/.exec(table)?.[1] ?? "";
    if (!stripHtml(firstRow).includes("Course Title")) continue;
    const before = html.slice(0, match.index);
    const headings = [...before.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/g)];
    const label = headings.length ? stripHtml(headings[headings.length - 1]![1]) : "";
    out.push({ label, rows: [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => rowCells(r[1])) });
  }
  return out;
}

/**
 * The fragment lists terms newest first; the transcript comes out chronological. Unposted rows
 * keep grade undefined; credits fall back to the in-progress column when VU Credit is zero
 * (W rows then carry 0 credits, which the GPA engine's nonGpa list already excludes).
 */
export function parseAaiRecord(html: string): Transcript {
  const tables = courseTables(html);
  if (tables.length === 0) {
    throw new Error("aai record: no course tables found — layout changed, or the session did not survive the dance");
  }
  const terms: TermRecord[] = [];
  for (const { label, rows } of [...tables].reverse()) {
    const courses: CourseRecord[] = [];
    let postedGpa: number | undefined;
    for (const cells of rows) {
      if (cells.length === 0) continue;
      const head = cells[0] ?? "";
      if (/^term totals/i.test(head)) {
        const gpa = Number.parseFloat(cells[cells.length - 1] ?? "");
        if (Number.isFinite(gpa)) postedGpa = gpa;
        continue;
      }
      if (/^cumulative totals/i.test(head)) continue; // recomputed by the engine, never copied
      if (/^course$/i.test(head) || cells.length < 6) continue; // header row or layout noise
      const grade = cells[3]?.trim();
      courses.push({
        course: head,
        credits: Math.max(num(cells[4]), num(cells[5])), // VU Credit, else VU In Prgrs
        ...(grade !== "" ? { grade } : {}),
      });
    }
    terms.push({ term: label, courses, ...(postedGpa !== undefined ? { postedGpa } : {}) });
  }
  return { terms };
}

/**
 * The aai shell hands the client its own fragment URLs (hx-get="...?studentId=..."), so no
 * identity is ever hardcoded: pull the academic-record URL out of the shell.
 */
export function discoverRecordFragmentUrl(shellHtml: string): string | null {
  const m = /hx-get="([^"]*\/aai\/academic-record\/academic-record[^"]*)"/.exec(shellHtml);
  return m ? m[1] : null;
}
