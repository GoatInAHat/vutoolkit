import { describe, expect, it } from "vitest";
import { discoverRecordFragmentUrl, parseAaiRecord } from "./aai-record.js";
import { cumulative } from "../gpa/engine.js";

/** Structure-faithful slice of the live fragment (2026-09-15): two course tables newest first,
 * sandwiching an info table that must be skipped; titles carry the live comment artifacts. */
const FRAGMENT = `
<div id="academic-record-accordion-0"><h2>Undergraduate 2024 Fall - 2026 Fall</h2>
<h4>2026 Fall</h4>
<table><tr><th>Course</th><th>Course Title</th><th>Instructor(s)/Instructional Staff</th><th>Grade</th><th>VU Credit</th><th>VU In Prgrs</th><th>Q Hrs</th><th>Q Pts</th><th>GPA</th></tr>
<tr><td>AI-1010-01</td><td>Survey of Gen AI Tools &amp; Apps <!-- rating link --></td><td>Jesse Spencer-Smith</td><td></td><td>0.00</td><td>3.00</td><td>0.00</td><td>0.00</td><td></td></tr>
<tr><td>CS-2281-02</td><td>Computer Architecture <!-- a > b --></td><td>Shervin Hajiamini</td><td></td><td>0.00</td><td>4.00</td><td>0.00</td><td>0.00</td><td></td></tr>
<tr><td>Cumulative Totals</td><td>17.00</td><td>7.00</td><td>12.00</td><td>38.45</td><td>3.204</td></tr>
</table>
</div>
<div><h4>2025 Fall</h4>
<table><tr><th>School:</th><th>School of Engineering</th></tr></table>
<table><tr><th>Course</th><th>Course Title</th><th>Instructor(s)/Instructional Staff</th><th>Grade</th><th>VU Credit</th><th>VU In Prgrs</th><th>Q Hrs</th><th>Q Pts</th><th>GPA</th></tr>
<tr><td>CS-1101-02</td><td>Programming &amp; Prob Sol <!-- x --></td><td>Rui (Gina) Bai</td><td>A</td><td>3.00</td><td>0.00</td><td>3.00</td><td>12.00</td><td></td></tr>
<tr><td>PE-9999-01</td><td>Withdrawn <!-- y --></td><td>Someone</td><td>W</td><td>0.00</td><td>0.00</td><td>0.00</td><td>0.00</td><td></td></tr>
<tr><td>Term Totals</td><td>3.00</td><td>0.00</td><td>3.00</td><td>12.00</td><td>4.000</td></tr>
<tr><td>Cumulative Totals</td><td>6.00</td><td>0.00</td><td>3.00</td><td>12.00</td><td>4.000</td></tr>
</table>
</div>`;

describe("parseAaiRecord", () => {
  it("extracts chronological terms with posted GPAs and clean courses", () => {
    const transcript = parseAaiRecord(FRAGMENT);
    expect(transcript.terms.map((t) => t.term)).toEqual(["2025 Fall", "2026 Fall"]);

    const [fall25, fall26] = transcript.terms;
    expect(fall26?.postedGpa).toBeUndefined(); // in-progress term has no Term Totals row
    expect(fall26?.courses).toEqual([
      { course: "AI-1010-01", credits: 3 }, // in-progress credits from the VU In Prgrs column
      { course: "CS-2281-02", credits: 4 },
    ]);

    expect(fall25?.postedGpa).toBe(4.0);
    expect(fall25?.courses).toContainEqual({ course: "CS-1101-02", credits: 3, grade: "A" });
    expect(fall25?.courses).toContainEqual({ course: "PE-9999-01", credits: 0, grade: "W" });
  });

  it("strips comment artifacts (including '>' inside comments) from titles", () => {
    const transcript = parseAaiRecord(FRAGMENT);
    expect(transcript.terms[1]?.courses[0]?.course).toBe("AI-1010-01");
    const raw = JSON.stringify(transcript);
    expect(raw).not.toContain("<!--");
    expect(raw).not.toContain("-->");
  });

  it("feeds the GPA engine: graded work only, engine-recomputed cumulative", () => {
    const transcript = parseAaiRecord(FRAGMENT);
    // Only the posted A (3cr x 4.0) is GPA-bearing; W and in-progress work are excluded.
    expect(cumulative(transcript)).toBe(4.0);
  });

  it("fails loudly on a fragment without course tables", () => {
    expect(() => parseAaiRecord("<html><body>logged out</body></html>")).toThrow(/no course tables/);
  });
});

describe("discoverRecordFragmentUrl", () => {
  it("pulls the academic-record hx-get URL the shell hands out", () => {
    const shell = `<div hx-get="/aai/academic-record/academic-record?studentId=000986534" hx-trigger="load"></div>
<div hx-get="/aai/immersion/immersion-information?studentId=000986534"></div>`;
    expect(discoverRecordFragmentUrl(shell)).toBe("/aai/academic-record/academic-record?studentId=000986534");
    expect(discoverRecordFragmentUrl("<html></html>")).toBeNull();
  });
});
