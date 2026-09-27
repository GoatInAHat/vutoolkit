import { describe, expect, it } from "vitest";
import { officialAuditGraph } from "./audit-graph.js";
import { scheduleInputSchema } from "./schemas.js";

describe("independent release review", () => {
  it("preserves unknown official counts instead of inventing zero requirements", () => {
    const graph = officialAuditGraph({ source: "live", fetchedAt: "synthetic", plannerCourses: [], audits: [{ reportSequence: 1,
      requirementGroups: [{ entrySequence: 1, name: "Unspecified remaining count", requirements: [] }] }] });
    const group = graph.nodes.find((node) => node.kind === "group");
    expect(group?.coursesNeeded).toBeUndefined();
    expect(group?.unitsNeeded).toBeUndefined();
  });
  it("rejects inverted break windows at the operation boundary", () => {
    expect(scheduleInputSchema.safeParse({ sections: [], blockedTimes: [{ days: ["M"], start: 800, end: 700 }] }).success).toBe(false);
  });
});
