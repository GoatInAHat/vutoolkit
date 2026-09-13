/**
 * YES write guard: the client boundary that makes "cart, never enrollment" structural rather
 * than behavioral. Every mutation passes classify(); anything not explicitly allowlisted as a
 * cart write is refused, and enrollment-shaped endpoints are refused outright — even if a
 * future allowlist entry accidentally names one.
 */

export interface PlannedWrite {
  url: string;
  method: string;
  body?: unknown;
  /** Human-readable intent for the dry-run plan. */
  label: string;
}

export type WriteClass = "read" | "cart-write" | "enrollment" | "blocked";

/** Mutations on anything matching these are refused unconditionally. Conservative on purpose. */
export const ENROLLMENT_PATTERNS: readonly RegExp[] = [/enroll/i, /register/i, /proreg/i];

/**
 * The only mutations vutoolkit may ever issue. Empty in v1: cart endpoints get added here
 * one-by-one as they are verified against live YES (gated). Default-deny until then.
 */
export const CART_WRITE_ALLOWLIST: readonly { pattern: RegExp; method: string }[] = [];

export class YesWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YesWriteBlockedError";
  }
}

export function classify(url: string, method: string): WriteClass {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return "read";
  if (ENROLLMENT_PATTERNS.some((p) => p.test(url))) return "enrollment";
  const allowed = CART_WRITE_ALLOWLIST.some((e) => e.method === verb && e.pattern.test(url));
  return allowed ? "cart-write" : "blocked";
}

/** Throw unless this is a read or an explicitly allowlisted cart write. */
export function assertSafe(url: string, method: string): void {
  const kind = classify(url, method);
  if (kind === "enrollment")
    throw new YesWriteBlockedError(
      `refused: ${method.toUpperCase()} ${url} is enrollment-shaped; vutoolkit modifies the cart, never enrollment`,
    );
  if (kind === "blocked")
    throw new YesWriteBlockedError(
      `refused: ${method.toUpperCase()} ${url} is not on the cart-write allowlist (default-deny)`,
    );
}

/** Dry-run-first: a mutation becomes a plan; only apply() after review may execute it. */
export interface DryRunPlan {
  label: string;
  url: string;
  method: string;
  body?: unknown;
  classification: WriteClass;
  executable: boolean;
}

export function planWrite(p: PlannedWrite): DryRunPlan {
  return {
    label: p.label,
    url: p.url,
    method: p.method.toUpperCase(),
    body: p.body,
    classification: classify(p.url, p.method),
    executable: classify(p.url, p.method) === "cart-write",
  };
}
