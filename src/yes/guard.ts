/**
 * YES write guard: academic records stay read-only. YES hosts get only reads; enrollment-shaped
 * routes are refused outright, and the cart and planner actions YES runs over GET are refused
 * too, since a method alone cannot establish read-only there. The `request` operation applies it
 * on every hop, and the Railway kit's signed-in browser applies it to every page request.
 */

/** YES and its student apps (aai, more, sam, landing). */
export function isYesHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "yes.vanderbilt.edu" || h.endsWith(".app.vanderbilt.edu");
}

/** Refused on YES whatever the method. Conservative on purpose. */
const ENROLLMENT_PATTERNS: readonly RegExp[] = [/enroll/i, /register/i, /proreg/i];
/** Cart and planner mutations YES issues as GET. */
const GET_MUTATION = /(?:StudentClassExecute!(?:add|remove)|PlannedCourseJson!save|PlannedCourse!remove)\.action/i;

export class YesWriteBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YesWriteBlockedError";
  }
}

export function classify(url: string, method: string): "read" | "enrollment" | "blocked" {
  let decoded = url;
  for (let n = 0; n < 2; n++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return "blocked";
    }
  }
  if (ENROLLMENT_PATTERNS.some((p) => p.test(decoded))) return "enrollment";
  const verb = method.toUpperCase();
  return (verb === "GET" || verb === "HEAD") && !GET_MUTATION.test(decoded) ? "read" : "blocked";
}

/** Throw unless this request is a read, or is not on a YES host at all. */
export function assertYesReadOnly(url: string, method: string): void {
  if (!isYesHost(new URL(url).hostname)) return;
  const kind = classify(url, method);
  if (kind === "read") return;
  throw new YesWriteBlockedError(
    kind === "enrollment"
      ? `refused: ${method.toUpperCase()} ${new URL(url).pathname} on YES is enrollment-shaped; vutoolkit never changes enrollment`
      : `refused: ${method.toUpperCase()} ${new URL(url).pathname} would change YES; academic records are read-only`,
  );
}
