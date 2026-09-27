import { describe, expect, it } from "vitest";
import { cartDifference, solveSchedules, type ScheduleSection } from "./scheduler.js";
const section = (id: string, course: string, start: number, end: number, component = "Lecture"): ScheduleSection => ({ id, course, section: id, component, meetings: [{ days: ["M", "W"], start, end }] });
describe("schedule selection", () => {
  it("enumerates conflict-free alternatives and permits touching endpoints", () => {
    const result = solveSchedules({ sections: [section("a1", "A", 600, 660), section("a2", "A", 660, 720), section("b", "B", 660, 700)] });
    expect(result.schedules.map((s) => s.sections.map((s) => s.id).sort())).toEqual([["a1", "b"]]);
    expect(result.searchComplete).toBe(true);
  });
  it("keeps lab components separate and enforces linked section compatibility", () => {
    const a = section("a", "A", 600, 660); a.compatibleWith = ["l2"];
    const result = solveSchedules({ sections: [a, section("l1", "A", 720, 780, "Lab"), section("l2", "A", 800, 860, "Lab")] });
    expect(result.schedules[0]!.sections.map((s) => s.id).sort()).toEqual(["a", "l2"]);
  });
  it("checks every meeting and ranks/filters break-time violations", () => {
    const a = section("a", "A", 600, 660); a.meetings.push({ days: ["F"], start: 900, end: 960 });
    const blockedTimes = [{ days: ["F"], start: 920, end: 940 }];
    expect(solveSchedules({ sections: [a], blockedTimes }).schedules[0]!.preferenceConflictMinutes).toBe(20);
    expect(solveSchedules({ sections: [a], blockedTimes, hidePreferenceConflicts: true }).found).toBe(0);
  });
  it("reports TBA uncertainty and truncation without calling partial search complete", () => {
    const a = section("a", "A", 600, 660); a.meetings = [];
    expect(solveSchedules({ sections: [a] }).warnings).toHaveLength(1);
    const result = solveSchedules({ sections: [a], maxSearchNodes: 1 });
    expect(result.truncated).toBe(true); expect(result.searchComplete).toBe(false);
  });
  it("preserves excluded/unrelated cart classes and never produces enrollment actions", () => {
    const a = section("a", "A", 600, 660), a2 = section("a2", "A", 700, 760), b = section("b", "B", 800, 860);
    expect(cartDifference(["a2", "b", "unrelated"], [a], [a, a2, b])).toEqual({ add: ["a"], remove: ["a2"], unchanged: ["b", "unrelated"] });
  });
  it("does not drop a required course or lab when all its sections are excluded", () => {
    const sections = [section("a", "A", 600, 660), section("lab", "A", 700, 760, "Lab"), section("b", "B", 800, 860)];
    const result = solveSchedules({ sections, excludedSectionIds: ["lab"] });
    expect(result.schedules).toEqual([]);
    expect(result.searchComplete).toBe(true);
    expect(result.warnings).toContain("No eligible sections remain for required group A · Lab. Exclude the course explicitly to omit it.");
    expect(result.incompatibleGroups).toEqual([]);
    const omitted = solveSchedules({ sections, excludedCourses: ["A"], excludedSectionIds: ["lab"] });
    expect(omitted.schedules[0]!.sections.map((section) => section.id)).toEqual(["b"]);
  });
});
