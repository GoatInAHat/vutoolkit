/** Authored wrapper: all surfaces share the same schema and whole-operation budget. */
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { Operation, Context } from "../toolfactory/types.js";
import { withDeadline } from "./errors.js";

export const ceremonyTools = new Set([
  "sessions.open", "sessions.refresh", "sessions.ensure", "graph.call", "record.fetch",
  "brightspace.fetch", "brightspace.api", "degree.audit", "degree.graph", "degree.options",
  "courses.search", "courses.detail", "courses.sections", "setup.run", "setup.prepare", "setup.enroll",
]);
const calls = new AsyncLocalStorage<{ signal?: AbortSignal }>();
export const authSignal = () => calls.getStore()?.signal;
export const checkAuthAbort = () => authSignal()?.throwIfAborted();

export function withCallerBudget(op: Operation): Operation {
  if (!ceremonyTools.has(op.name)) return op;
  const previous = op.input.shape.timeoutSeconds;
  // Preserve legacy setup defaults, but accept the harness's entire supported range.
  let timeout = z.number().int().min(1).max(570).optional();
  const oldDefault = previous?.safeParse(undefined);
  const field = oldDefault?.success && typeof oldDefault.data === "number"
    ? timeout.default(oldDefault.data) : timeout;
  return { ...op,
    input: op.input.extend({ timeoutSeconds: field }),
    description: op.description + " Pass timeoutSeconds: 300 when a sign-in may be needed (integer 1-570; whole-call deadline).",
    handler: async (args, ctx) => {
      const signal = (ctx as Context & { signal?: AbortSignal }).signal;
      signal?.throwIfAborted();
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      let timer: NodeJS.Timeout | undefined;
      const seconds = args.timeoutSeconds as number | undefined;
      if (seconds !== undefined) timer = setTimeout(() => controller.abort(), seconds * 1000);
      const work = calls.run({ signal: controller.signal }, async () => {
        checkAuthAbort();
        const result = await op.handler(args, ctx);
        checkAuthAbort();
        return result;
      });
      try { return seconds === undefined ? await work : await withDeadline(work, seconds * 1000, op.name); }
      finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    },
  };
}
