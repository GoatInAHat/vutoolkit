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
  it("ranks all supplied official requirement alternatives together and counts a shared prerequisite once", () => {
    const result = buildDegreeGraph({ requirements: [
      { id: "major-core", label: "Major core", expression: parsePrerequisites("CS 3000 or CS 3100") },
      { id: "capstone", expression: parsePrerequisites("CS 4000") },
    ], courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
      { course: "CS 3100", credits: 3, prerequisites: parsePrerequisites("CS 2000") },
      { course: "CS 4000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
    ] });
    expect(result.alternatives[0]).toMatchObject({ courses: ["CS 1000", "CS 3000", "CS 4000"], credits: 9, plannedCourses: [] });
    expect(result.modelOptimal).toBe(true);
    expect(result.rankingScope).toContain("supplied official requirement alternatives");
    expect(result.nodes.find((node) => node.id === "requirement:major-core")?.kind).toBe("requirement");
  });
  it("keeps planned work visible, maps its prerequisites, and excludes its credits from additional work", () => {
    const result = buildDegreeGraph({ planned: ["CS 3000"], requirements: [{ id: "core", expression: parsePrerequisites("CS 3000") }], courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
    ] });
    expect(result.alternatives[0]).toMatchObject({ courses: ["CS 1000"], plannedCourses: ["CS 3000"], credits: 3 });
    expect(result.modelOptimal).toBe(true);
  });
  it("does not advertise a model optimum for unresolved supplied requirement alternatives", () => {
    const result = buildDegreeGraph({ requirements: [{ id: "elective", expression: { kind: "unknown", text: "Official wildcard: verify with adviser" } }], courses: [] });
    expect(result.modelOptimal).toBe(false);
    expect(result.alternatives[0]?.unresolved).toContain("Official wildcard: verify with adviser");
  });
  it("selects a globally shared prerequisite path even when a requirement's local option costs more", () => {
    const result = buildDegreeGraph({ requirements: [
      { id: "first", expression: parsePrerequisites("CS 3000 or CS 3100") },
      { id: "second", expression: parsePrerequisites("CS 4000") },
    ], courses: [
      { course: "CS 1000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
      { course: "CS 3100", credits: 3, prerequisites: parsePrerequisites("CS 2000") },
      { course: "CS 4000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
    ] });
    // CS 3100 is cheaper in isolation, but CS 3000 shares CS 1000 with CS 4000.
    expect(result.alternatives[0]).toMatchObject({ courses: ["CS 1000", "CS 3000", "CS 4000"], credits: 10, score: 10 });
    expect(result.modelOptimal).toBe(true);
  });
  it("uses positive and negative preferences in the exhaustive model score", () => {
    const result = buildDegreeGraph({ requirements: [{ id: "choice", expression: parsePrerequisites("CS 3000 or CS 4000") }], preferences: { "CS 4000": 3, "CS 1000": -4 }, courses: [
      { course: "CS 1000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("CS 1000") },
      { course: "CS 4000", credits: 3, prerequisites: parsePrerequisites("CS 2000") },
    ] });
    expect(result.alternatives[0]).toMatchObject({ courses: ["CS 2000", "CS 4000"], credits: 7, score: 4 });
    expect(result.modelOptimal).toBe(true);
  });
  it("never calls a capped enumeration model-optimal, even when the retained path has known metadata", () => {
    const result = buildDegreeGraph({ maxAlternatives: 1, requirements: [{ id: "choice", expression: parsePrerequisites("CS 1000 or CS 2000") }], courses: [
      { course: "CS 1000", credits: 4, prerequisites: parsePrerequisites("none") },
      { course: "CS 2000", credits: 3, prerequisites: parsePrerequisites("none") },
    ] });
    expect(result.truncated).toBe(true);
    expect(result.modelOptimal).toBe(false);
  });
  it("makes planned work mandatory while allowing it to satisfy an alternative", () => {
    const result = buildDegreeGraph({ planned: ["CS 3000"], requirements: [{ id: "choice", expression: parsePrerequisites("CS 3000 or CS 4000") }], courses: [
      { course: "CS 3000", credits: 3, prerequisites: parsePrerequisites("none") },
      { course: "CS 4000", credits: 3, prerequisites: parsePrerequisites("none") },
    ] });
    expect(result.alternatives[0]).toMatchObject({ courses: [], plannedCourses: ["CS 3000"], credits: 0 });
    expect(result.alternatives.every((alternative) => alternative.plannedCourses.includes("CS 3000"))).toBe(true);
  });
  it("does not call an empty or fully satisfied target set model-optimal", () => {
    expect(buildDegreeGraph({ courses: [] }).modelOptimal).toBe(false);
    expect(buildDegreeGraph({ courses: [], requirements: [{ id: "done", satisfied: true, expression: { kind: "unknown", text: "not used" } }] }).modelOptimal).toBe(false);
  });
});
