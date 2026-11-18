/**
 * vutoolkit's operations: pure functions of (JSON arguments, environment/config, filesystem).
 * Host-provided capabilities are declared with `requires`; toolfactory decides per surface
 * whether each operation is native, bridged, degraded, or excluded.
 *
 * The toolkit's job is the session: minting it (OneVU passkey ceremony, Microsoft Entra carry),
 * keeping it alive and riding it through each service's sign-in dance. `request` hands the agent
 * any Vanderbilt or Microsoft web API on that session directly; the remaining operations exist
 * only where the toolkit adds something the raw API does not (a parsed transcript, GPA math,
 * the official degree audit, conflict-free schedules).
 */
import { withCallerBudget } from "./sso/budget.js";
import { readFileSync } from "node:fs";
import { yesOperations } from "./yes/operations.js";
import { z } from "zod";
import { verifyTranscript, whatIf, type Transcript } from "./gpa/engine.js";
import { academicRecord } from "./yes/client.js";
import { vaultNotWired } from "./vault/index.js";
import { harvestToStoredSession, idpForHost } from "./vault/file-store.js";
import { ensureSession } from "./sso/ensure.js";
import { operation, type Context, type Operation } from "./toolfactory/types.js";
import { setupOperations } from "./sso/setup-operations.js";
import { CookieJar, sessionFetch } from "./http/session-fetch.js";
import { vaultStore, withSession } from "./http/with-session.js";

const idp = z.enum(["vanderbilt", "microsoft"]);
const transcriptSchema = z.object({
  postedCumulativeGpa: z.number().optional(),
  terms: z.array(
    z.object({
      term: z.string(),
      postedGpa: z.number().optional(),
      courses: z.array(
        z.object({
          course: z.string(),
          credits: z.number(),
          gpaCredits: z.number().nonnegative().optional(),
          grade: z.string().optional(),
        }),
      ),
    }),
  ),
});
const verificationSchema = z.object({
  ok: z.boolean(),
  rows: z.array(z.object({ term: z.string(), posted: z.number(), recomputed: z.number().nullable(), match: z.boolean() })),
  cumulative: z.number().nullable(),
  cumulativeCheck: z.object({ posted: z.number().nullable(), recomputed: z.number().nullable(), match: z.boolean().nullable() }),
  note: z.string(),
});
const sessionResult = z.object({
  source: z.enum(["cache", "minted"]),
  idp,
  acquiredAt: z.string(),
  expiresAt: z.string().optional(),
  healthy: z.boolean(),
  finalUrl: z.string().optional(),
  passkeyVerified: z.boolean().optional(),
  assertedSignCount: z.number().optional(),
});

const liveRecord = (ctx: Context): Promise<Transcript> => withSession(ctx, ["vanderbilt"], (cookies) => academicRecord(cookies));

const authored: Operation[] = [
  ...setupOperations,
  ...yesOperations,
  operation({
    name: "request",
    description:
      "Send one HTTP request to any Vanderbilt (*.vanderbilt.edu) or Microsoft 365 (Outlook, Office, SharePoint, login) web endpoint as the signed-in student, and get the service's own response back. The stored sessions ride every sign-in hop (OneVU/Okta, Entra, SAML and OIDC form posts); a refused session is re-minted with the toolkit passkey and the request retried once, so there is no sign-in step for the caller. Use it for the services' own APIs, e.g. Brightspace's D2L Valence API (https://brightspace.vanderbilt.edu/d2l/api/lp/1.46/users/whoami, /d2l/api/lp/1.46/enrollments/myenrollments/, /d2l/api/le/1.75/{orgUnitId}/content/toc, /d2l/api/le/1.75/{orgUnitId}/dropbox/folders/, /d2l/api/le/1.75/{orgUnitId}/grades/values/myGradeValues/, /d2l/api/le/1.75/{orgUnitId}/news/), YES pages, or Outlook on the web. Cookie values never appear in the result. A non-GET request acts on the student's account: send one only for something the student asked for.",
    input: z.object({
      url: z.string().url().describe("Absolute https URL on a Vanderbilt or Microsoft 365 host"),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra request headers (a Cookie header is ignored)"),
      body: z.string().optional().describe("Request body, sent as given; set content-type in headers"),
      maxChars: z.number().int().min(100).max(200_000).default(20_000).describe("Bound on the returned response text"),
    }),
    output: z.object({
      status: z.number(),
      url: z.string(),
      contentType: z.string(),
      headers: z.record(z.string(), z.string()),
      text: z.string(),
      truncated: z.boolean(),
      trace: z.array(z.string()),
    }),
    requires: ["net", "secret"],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async ({ url, method, headers, body, maxChars }, ctx) => {
      const target = new URL(url);
      const owner = target.protocol === "https:" ? idpForHost(target.hostname) : null;
      if (!owner) throw new Error(`request only reaches https Vanderbilt or Microsoft 365 hosts; ${target.protocol}//${target.hostname} is neither`);
      const res = await withSession(ctx, [owner], (cookies) =>
        sessionFetch({ url, method, headers, body }, { jar: new CookieJar(cookies) }),
      );
      return { ...res, text: res.text.slice(0, maxChars), truncated: res.text.length > maxChars };
    },
  }),
  operation({
    name: "sessions.list",
    description:
      "Cached Vanderbilt SSO and Microsoft sessions: metadata only (idp, acquired, expiry, health). Session values never leave the vault.",
    input: z.object({}),
    output: z.object({
      sessions: z.array(z.object({ idp: z.string(), acquiredAt: z.string(), expiresAt: z.string().optional(), healthy: z.boolean() })),
    }),
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => ({ sessions: await vaultStore(ctx).list() }),
  }),
  operation({
    name: "sessions.ensure",
    description:
      "Return the cached session for the IdP when it still works, or mint a fresh one and cache it: the OneVU passkey ceremony for vanderbilt, the Entra carry for microsoft. force=true re-mints even a working session; a failed mint keeps the current one. Other operations call this themselves, so it is only needed to warm or repair a session.",
    input: z.object({ idp, force: z.boolean().default(false) }),
    output: sessionResult,
    requires: ["secret", "net"],
    handler: async ({ idp, force }, ctx) => ensureSession(idp, vaultStore(ctx), force ? { forceRefresh: true } : {}),
  }),
  operation({
    name: "sessions.open",
    description:
      "Injection payload for a stored session, for a local browser on the student's own machine: raw Cookie header, CDP Network.setCookie params, or Playwright storageState. Never logged or echoed anywhere else. Remote deployments do not offer it.",
    input: z.object({ idp, format: z.enum(["cookie-header", "cdp", "storage-state"]).default("cookie-header") }),
    output: z.object({ payload: z.unknown() }),
    requires: ["secret", "net"],
    handler: async ({ idp, format }, ctx) => {
      const store = vaultStore(ctx);
      await ensureSession(idp, store);
      const session = await store.get(idp);
      if (!session) throw vaultNotWired(`sessions.open(${idp}): the session vault holds no session after ensure`);
      if (format === "cookie-header") return { payload: session.cookieHeader };
      const cookies = store.cookies(idp);
      if (format === "cdp") return { payload: cookies };
      return { payload: { cookies: cookies.map((c) => ({ ...c, expires: c.expires ?? -1 })), origins: [] } };
    },
  }),
  operation({
    name: "sessions.forget",
    description: "Drop a cached session: removes its row (metadata and values) from the session vault.",
    input: z.object({ idp }),
    output: z.object({ removed: z.boolean() }),
    handler: async ({ idp }, ctx) => {
      const store = vaultStore(ctx);
      const existed = (await store.get(idp)) !== null;
      await store.forget(idp);
      return { removed: existed };
    },
  }),
  operation({
    name: "sessions.ingest",
    description:
      "Ingest a harvested browser cookie export into the session store: keeps only cookies in the IdP's domain scope and reports metadata only.",
    input: z.object({
      idp,
      sourcePath: z.string().describe("Path to the harvested cookie JSON: a CDP cookie array, {cookies:[...]}, or {cookieHeader}"),
    }),
    output: z.object({ idp, ingested: z.number(), acquiredAt: z.string(), expiresAt: z.string().optional() }),
    requires: ["secret", "fs"],
    handler: async ({ idp, sourcePath }, ctx) => {
      const raw: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
      const session = harvestToStoredSession(idp, raw, new Date().toISOString());
      await vaultStore(ctx).put(session);
      return { idp, ingested: session.cookies.length, acquiredAt: session.acquiredAt, expiresAt: session.expiresAt };
    },
  }),
  operation({
    name: "record.fetch",
    description:
      "The student's YES academic record as a parsed transcript (posted terms plus in-progress unposted courses), with a check that recomputes each term's GPA and the cumulative GPA from the posted marks and compares them with Vanderbilt's own posted figures. Trust a what-if only when verification.ok is true.",
    input: z.object({}),
    output: z.object({ transcript: transcriptSchema, verification: verificationSchema }),
    requires: ["net", "secret"],
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => {
      const transcript = await liveRecord(ctx);
      return { transcript, verification: verifyTranscript(transcript) };
    },
  }),
  operation({
    name: "grades.whatif",
    description:
      "GPA projection: apply hypothetical grades (replacing posted ones, filling unposted ones) and report per-term and cumulative GPAs. Uses the student's live YES record unless a transcript is passed.",
    input: z.object({
      transcript: transcriptSchema.optional().describe("Omit to use the live YES record"),
      hypotheticals: z.array(z.object({ course: z.string(), grade: z.string() })).default([]),
    }),
    output: z.object({
      terms: z.array(z.object({ term: z.string(), gpa: z.number().nullable(), gpaCredits: z.number(), qualityPoints: z.number(), changed: z.boolean() })),
      cumulative: z.number().nullable(),
      cumulativeGpaCredits: z.number(),
      cumulativeQualityPoints: z.number(),
    }),
    requires: ["net", "secret"],
    annotations: { readOnlyHint: true },
    handler: async ({ transcript, hypotheticals }, ctx) => whatIf(transcript ?? (await liveRecord(ctx)), hypotheticals),
  }),
];

export const operations = authored.map((op) => withCallerBudget(op));
