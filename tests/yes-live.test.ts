/** Read-only live acceptance: report booleans/counts only; never print student records. */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { operations } from "../src/ops.js";
import { context } from "../src/toolfactory/config.js";
const live = Boolean(process.env.VUTOOLKIT_LIVE);
describe.skipIf(!live)("live YES planner/catalog/scheduler", () => {
  const ctx = context(); let vitestMarker: string | undefined;
  beforeAll(() => { vitestMarker = process.env.VITEST; delete process.env.VITEST; });
  afterAll(() => { if (vitestMarker !== undefined) process.env.VITEST = vitestMarker; });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const op = operations.find((o) => o.name === name); if (!op) throw new Error(`missing operation ${name}`);
    try { const result = await op.handler(op.input.parse(args) as never, ctx); return op.output!.parse(result) as any; }
    catch { throw new Error(`${name} live read failed; inspect private diagnostics locally`); }
  }
  let graph: any;
  it("loads official audit requirements and planner courses as a directed graph", async () => {
    graph = await call("degree.graph");
    expect(graph.source === "live").toBe(true); expect(graph.nodes.length > 0).toBe(true);
    expect(graph.nodes.some((n: any) => n.kind === "line")).toBe(true); expect(graph.edges.length > 0).toBe(true);
    const ids = new Set(graph.nodes.map((n: any) => n.id)); expect(graph.edges.every((e: any) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  }, 420000);
  it("retrieves official course alternatives for a real audit requirement", async () => {
    graph ??= await call("degree.graph");
    const target = graph.nodes.find((n: any) => n.kind === "line" && n.hasPossibleCourses);
    expect(Boolean(target)).toBe(true);
    const result = await call("degree.options", { reportSequence: target.reportSequence, entrySequence: target.entrySequence });
    expect(result.source === "live").toBe(true); expect(result.courses.length > 0).toBe(true);
    expect(result.courses.every((c: any) => typeof c.courseId === "string" || c.wildcard)).toBe(true);
  }, 420000);
  it("reads course metadata and parses a live OR prerequisite expression", async () => {
    const courses = await call("courses.search", { keywords: "CS 3251" });
    const target = courses.courses.find((c: any) => c.course === "CS 3251"); expect(Boolean(target)).toBe(true);
    const detail = await call("courses.detail", { id: target.id, offerNumber: target.offerNumber });
    expect(Boolean(detail.description)).toBe(true); expect(detail.prerequisites.kind === "any").toBe(true);
    expect(detail.prerequisites.items.length >= 2).toBe(true);
  }, 420000);
  it("solves current live section alternatives without writing the cart", async () => {
    const result = await call("courses.sections", { keywords: "CS 3251" });
    expect(result.source === "live" && result.sections.length > 0).toBe(true);
    const sections = result.sections.filter((s: any) => s.course === "CS 3251"); expect(sections.length > 0).toBe(true);
    const schedules = await call("scheduler.solve", { sections });
    expect(schedules.schedules.length > 0).toBe(true); expect(schedules.searchComplete === true).toBe(true);
  }, 420000);
  it("reads public Vanderbilt professor ratings without sending account credentials", async () => {
    const result = await call("professors.search", { name: "Graham Hemingway" });
    expect(result.professors.length > 0).toBe(true);
    expect(result.professors.some((p: any) => p.url.startsWith("https://www.ratemyprofessors.com/professor/"))).toBe(true);
  }, 60000);
});
