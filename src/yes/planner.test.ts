import { describe, expect, it } from "vitest";
import { buildDegreeGraph, parsePrerequisites } from "./planner.js";
describe("prerequisite planning", () => {
  it("preserves nested AND/OR and Oxford alternatives from the live catalog", () => {
    expect(parsePrerequisites("CS 2201, ECE 2201, or CS 2205.")).toEqual({ kind: "any", items: [{ kind: "course", course: "CS 2201" }, { kind: "course", course: "ECE 2201" }, { kind: "course", course: "CS 2205" }] });
    expect(parsePrerequisites("(CS 1101 or CS 1104) and MATH 1300").kind).toBe("all");
    expect(parsePrerequisites("CS 1101 with grade of C or instructor consent").kind).toBe("unknown");
  });
  it("ranks paths using unique shared prerequisite credits", () => {
    const result = buildDegreeGraph({ goals: ["CS 3000", "CS 4000"], courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000 or CS 2000") },
      { course: "CS 4000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
    ] });
    expect(result.alternatives[0]!.credits).toBe(9); expect(result.alternatives).toHaveLength(2);
    expect(result.nodes.some((n) => n.kind === "any")).toBe(true);
  });
  it("never treats missing metadata or cycles as eligible", () => {
    const result = buildDegreeGraph({ goals: ["CS 1000"], courses: [{ course: "CS 1000", prerequisites: parsePrerequisites("CS 2000") }, { course: "CS 2000", prerequisites: parsePrerequisites("CS 1000") }] });
    expect(result.warnings[0]).toContain("cycle"); expect(result.alternatives[0]!.unresolved.length).toBeGreaterThan(0);
  });
  it("completed work removes prerequisite cost; optional planner courses stay visible", () => {
    const result = buildDegreeGraph({ completed: ["CS 1000"], planned: ["CS 3000"], goals: ["CS 2000"], courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 3, prerequisites: parsePrerequisites("CS 1000") }, { course: "CS 3000", credits: 3 },
    ] });
    expect(result.alternatives[0]!.credits).toBe(3); expect(result.nodes.find((n) => n.id === "CS 2000")?.state).toBe("available");
    expect(result.nodes.find((n) => n.id === "CS 3000")?.state).toBe("planned");
  });

  it("keeps goals with missing metadata visible and applies normalized preference keys", () => {
    const missing = buildDegreeGraph({ courses: [], goals: ["CS-9999"] });
    expect(missing.nodes.find((node) => node.id === "CS 9999")?.state).toBe("unknown");
    expect(missing.alternatives[0]!.creditsComplete).toBe(false);
    const ranked = buildDegreeGraph({ courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000 or CS 2000") },
    ], goals: ["CS 3000"], preferences: { "cs-2000": 1 } });
    expect(ranked.alternatives[0]!.courses).toContain("CS 2000");
  });

  it("does not label sampled prerequisite costs as proven minima after truncation", () => {
    const result = buildDegreeGraph({ maxAlternatives: 1, goals: ["CS 3000"], courses: [
      { course: "CS 1000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000 or CS 2000") },
    ] });
    expect(result.truncated).toBe(true);
    expect(result.nodes.every((node) => node.minimumAdditionalCredits === undefined)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("not a proven global optimum"))).toBe(true);
  });
  it("keeps the proven credit minimum independent of preference-weighted ranking", () => {
    const result = buildDegreeGraph({ goals: ["CS 3000"], preferences: { "CS 2000": 10 }, courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000 or CS 2000") },
    ] });
    expect(result.alternatives[0]!.courses).toContain("CS 2000");
    expect(result.nodes.find((node) => node.id === "CS 3000")?.minimumAdditionalCredits).toBe(3);
  });
  it("does not prove a minimum when another prerequisite path is unknown", () => {
    const result = buildDegreeGraph({ goals: ["CS 3000"], courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000 or CS 2000") },
    ] });
    expect(result.nodes.find((node) => node.id === "CS 3000")?.minimumAdditionalCredits).toBeUndefined();
  });
});
