import { describe, expect, it } from "vitest";
import { operations } from "../ops.js";
const names = ["sessions.open", "sessions.refresh", "sessions.ensure", "graph.call", "record.fetch", "brightspace.fetch", "brightspace.api", "degree.audit", "degree.graph", "degree.options", "courses.search", "courses.detail", "courses.sections", "setup.run", "setup.prepare", "setup.enroll"];
describe("ceremony caller schemas", () => {
  for (const name of names.filter(name => operations.some(op => op.name === name))) it(`${name} preserves caller budget and bounds it`, () => {
    const op = operations.find(op => op.name === name)!;
    const field = op.input.shape.timeoutSeconds;
    expect(field).toBeDefined();
    for (const value of [1, 300, 570]) expect(field.safeParse(value).success).toBe(true);
    for (const value of [0, 571, 1.5]) expect(field.safeParse(value).success).toBe(false);
    expect(op.description).toContain("timeoutSeconds: 300");
  });
});

import { vi } from "vitest";
import { z } from "zod";
import { authSignal, withCallerBudget } from "./budget.js";
import type { Context } from "../toolfactory/types.js";
describe("whole operation deadline", () => {
  it("aborts pending work at the explicit budget", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const op = withCallerBudget({ name: "sessions.ensure", description: "fake", input: z.object({}),
      handler: async () => { observed = authSignal(); return new Promise(() => {}); } });
    try {
      const result = op.handler({ timeoutSeconds: 1 }, { config: {}, dataDir: "/unused" });
      const failed = expect(result).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(1000); await failed;
      expect(observed?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("passes the native caller's abort to internal auth without starting new work", async () => {
    const controller = new AbortController(); controller.abort(); const handler = vi.fn();
    const op = withCallerBudget({ name: "sessions.ensure", description: "fake", input: z.object({}), handler });
    await expect(op.handler({}, { config: {}, dataDir: "/unused", signal: controller.signal } as Context)).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
