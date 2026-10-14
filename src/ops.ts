/**
 * vutoolkit's operations: pure functions of (JSON arguments, environment/config, filesystem).
 * Host-provided capabilities are declared with `requires`; toolfactory decides per surface
 * whether each operation is native, bridged, degraded, or excluded. Anything touching session
 * values or passkey material goes through the vault contract (src/vault/index.ts) and is
 * honestly gated until their wiring lands. Session and Graph operations use the configured
 * credential backend; sessions.refresh re-mints through the same store plus the
 * CDP ceremony (OneVU passkey or Microsoft Entra carry).
 */
import { readFileSync } from "node:fs";
import { yesOperations } from "./yes/operations.js";
import { z } from "zod";
import { verifyTranscript, whatIf } from "./gpa/engine.js";
import { SYNTHETIC_TRANSCRIPT } from "./gpa/fixtures.js";
import { YesClient } from "./yes/client.js";
import { vaultNotWired } from "./vault/index.js";
import { sessionStore, harvestToStoredSession } from "./vault/file-store.js";
import { defaultSecretsRead, ensureSession } from "./sso/ensure.js";
import { graphCall } from "./graph/client.js";
import { ensureGraphToken, graphTokenCache } from "./graph/token.js";
import { operation, type Context } from "./toolfactory/types.js";
import { setupOperations } from "./sso/setup-operations.js";
import { credentialEnv } from "./vault/credential-store.js";
import { BrightspaceClient, BrightspaceNotConfiguredError } from "./brightspace/client.js";

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
type TranscriptArgs = z.infer<typeof transcriptSchema>;

const vaultStore = (ctx: Context) => sessionStore(ctx.dataDir, credentialEnv(ctx.config));

/**
 * Optional login_hint for the silent Graph authorize: env first, then the vault. Absence is fine -
 * the vaulted session's cookies carry the identity (live-proven without a hint 2026-09-21).
 */
const bestEffortLoginHint = (): string | undefined => {
  if (process.env.VUTOOLKIT_VU_EMAIL) return process.env.VUTOOLKIT_VU_EMAIL;
  try {
    return defaultSecretsRead("VANDERBILT_EMAIL");
  } catch {
    return undefined;
  }
};

export const operations = [
  ...setupOperations,
  ...yesOperations,
  operation({
    name: "sessions.list",
    description:
      "Cached Vanderbilt SSO and Microsoft sessions: metadata only (idp, acquired, expiry, health). Session values never leave the vault.",
    input: z.object({}),
    output: z.object({
      sessions: z.array(
        z.object({
          idp: z.string(),
          acquiredAt: z.string(),
          expiresAt: z.string().optional(),
          healthy: z.boolean(),
        }),
      ),
    }),
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => ({ sessions: await vaultStore(ctx).list() }),
  }),
  operation({
    name: "sessions.open",
    description:
      "Injection payload for a stored session: raw Cookie header, CDP Network.setCookie params, or Playwright storageState. Values resolve from the session vault fed by sessions.ingest; never logged, never echoed anywhere else.",
    input: z.object({
      idp: z.enum(["vanderbilt", "microsoft"]),
      format: z.enum(["cookie-header", "cdp", "storage-state"]).default("cookie-header"),
    }),
    output: z.object({ payload: z.unknown() }),
    requires: ["secret", "net"],
    handler: async ({ idp, format }, ctx) => {
      const store = vaultStore(ctx);
      // Serve only a live session: ensure re-mints a missing or dead one before the payload is built.
      await ensureSession(idp, store);
      const session = await store.get(idp);
      if (!session) throw vaultNotWired(`sessions.open(${idp}): the session vault holds no session after ensure`);
      if (format === "cookie-header") return { payload: session.cookieHeader };
      if (format === "cdp") {
        return {
          payload: store.cookies(idp).map(({ name, value, domain, path, expires, httpOnly, secure, sameSite }) => ({
            name, value, domain, path, expires, httpOnly, secure, sameSite,
          })),
        };
      }
      return {
        payload: {
          cookies: store.cookies(idp).map((c) => ({ ...c, expires: c.expires ?? -1 })),
          origins: [],
        },
      };
    },
  }),
  operation({
    name: "sessions.refresh",
    description:
      "Re-mint and replace the cached session after successful authentication. Vanderbilt refresh proves a passkey assertion in an empty browser context; Microsoft uses the Entra carry. A failed refresh preserves the current vault entry.",
    input: z.object({
      idp: z.enum(["vanderbilt", "microsoft"]).default("vanderbilt"),
    }),
    output: z.object({
      source: z.literal("minted"),
      idp: z.enum(["vanderbilt", "microsoft"]),
      acquiredAt: z.string(),
      expiresAt: z.string().optional(),
      healthy: z.boolean(),
      finalUrl: z.string().optional(),
      passkeyVerified: z.boolean().optional(),
      assertedSignCount: z.number().optional(),
    }),
    requires: ["secret", "net"],
    handler: async ({ idp }, ctx) => {
      const store = vaultStore(ctx);
      const result = await ensureSession(idp, store, { forceRefresh: true });
      return { ...result, source: "minted" as const };
    },
  }),
  operation({
    name: "sessions.forget",
    description:
      "Drop a cached session: removes its row (metadata and values) from the session vault.",
    input: z.object({ idp: z.enum(["vanderbilt", "microsoft"]) }),
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
      "Ingest a harvested browser cookie export into the configured session store: keeps only cookies in the IdP's domain scope and reports metadata only. OpenClaw deployments select the native vault; standalone file storage is supported. The harvest itself is produced by the host browser outside this toolkit.",
    input: z.object({
      idp: z.enum(["vanderbilt", "microsoft"]),
      sourcePath: z.string().describe(
        "Path to the harvested cookie JSON: a CDP cookie array, {cookies:[...]}, or {cookieHeader}",
      ),
    }),
    output: z.object({
      idp: z.enum(["vanderbilt", "microsoft"]),
      ingested: z.number(),
      acquiredAt: z.string(),
      expiresAt: z.string().optional(),
    }),
    requires: ["secret", "fs"],
    handler: async ({ idp, sourcePath }, ctx) => {
      const raw: unknown = JSON.parse(readFileSync(sourcePath, "utf8"));
      const session = harvestToStoredSession(idp, raw, new Date().toISOString());
      await vaultStore(ctx).put(session);
      return { idp, ingested: session.cookies.length, acquiredAt: session.acquiredAt, expiresAt: session.expiresAt };
    },
  }),
  operation({
    name: "sessions.ensure",
    description:
      "Zero-step auth: return the cached session for the IdP, or mint a fresh one over CDP and cache it — OneVU passkey ceremony for vanderbilt, Entra-carry (identifier-first + KMSI fallback) for microsoft. Secrets resolve from the OpenClaw vault (VANDERBILT_EMAIL, VANDERBILT_PASSKEY) or VUTOOLKIT_VU_EMAIL / VUTOOLKIT_PASSKEY_JSON / VUTOOLKIT_CDP_URL env overrides. The browser is driven in its own tab, so a shared managed browser is never disturbed.",
    input: z.object({ idp: z.enum(["vanderbilt", "microsoft"]) }),
    output: z.object({
      source: z.enum(["cache", "minted"]),
      idp: z.enum(["vanderbilt", "microsoft"]),
      acquiredAt: z.string(),
      expiresAt: z.string().optional(),
      healthy: z.boolean(),
      finalUrl: z.string().optional(),
      passkeyVerified: z.boolean().optional(),
      assertedSignCount: z.number().optional(),
    }),
    requires: ["secret", "net"],
    handler: async ({ idp }, ctx) => ensureSession(idp, vaultStore(ctx)),
  }),
  operation({
    name: "graph.call",
    description:
      "Call Microsoft Graph as the student with zero-step auth: the vaulted Microsoft session's Entra cookies silently mint a Graph token (no browser, no interaction; cached ~1h, re-minted on demand). path is a v1.0 path like /me or /me/mailFolders/inbox/messages; query carries OData parameters (for example {\"$top\": 10, \"$select\": \"subject,from\"}). GETs are reads; POST/PATCH/PUT/DELETE change the real mailbox and calendar - reserve them for approved actions.",
    input: z.object({
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
      path: z.string().regex(/^\/(?!\/)/, "a relative Graph v1.0 path starting with a single /"),
      query: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      body: z.unknown().optional(),
    }),
    output: z.object({ status: z.number(), data: z.unknown() }),
    requires: ["net", "secret"],
    handler: async ({ method, path, query, body }, ctx) => {
      const store = vaultStore(ctx);
      await ensureSession("microsoft", store);
      const cache = graphTokenCache(ctx.dataDir, credentialEnv(ctx.config));
      const getToken = (opts: { force?: boolean }): Promise<string> =>
        ensureGraphToken(store.cookies("microsoft"), cache, { ...opts, loginHint: bestEffortLoginHint() }).then(
          (token) => token.accessToken,
        );
      return graphCall(method, path, query, body, getToken);
    },
  }),
  operation({
    name: "record.fetch",
    description:
      "The YES academic record: posted terms plus in-progress unposted courses. Fixture mode for development and tests; live mode rides the cached vanderbilt session through the aai OIDC dance (mints one via the OneVU ceremony over CDP when the vault is empty) — zero manual steps.",
    input: z.object({
      fixturePath: z
        .string()
        .optional()
        .describe("Read the transcript from this JSON file instead of live YES (dev/test)"),
    }),
    output: z.object({ transcript: transcriptSchema, source: z.enum(["fixture", "live"]) }),
    requires: ["net", "secret"],
    handler: async ({ fixturePath }, ctx) => {
      if (fixturePath) {
        const transcript = JSON.parse(readFileSync(fixturePath, "utf8")) as TranscriptArgs;
        return { transcript, source: "fixture" as const };
      }
      const store = vaultStore(ctx);
      const readRecord = () => new YesClient({ cookies: store.cookies("vanderbilt") }).academicRecord();
      // ensureSession probes the cached session and re-mints it when dead, so the common case is
      // one healthy fetch. The retry covers the narrow race where the session dies between the
      // probe and this fetch: force a re-mint once before surfacing a failure to the agent.
      await ensureSession("vanderbilt", store);
      try {
        return { transcript: await readRecord(), source: "live" as const };
      } catch {
        await store.forget("vanderbilt");
        await ensureSession("vanderbilt", store);
        return { transcript: await readRecord(), source: "live" as const };
      }
    },
  }),
  operation({
    name: "brightspace.fetch",
    description:
      "Read-only authenticated fetch of one brightspace.vanderbilt.edu page riding the cached vanderbilt session (same OneVU IdP as YES: walks the dance, submits the SAML assertion hop when the IdP requires POST binding). Returns status, final URL, page title and the HTML stripped to bounded text. Cookie values never leave the vault; the entry URL is pinned to brightspace.vanderbilt.edu and no D2L write route is reachable.",
    input: z.object({
      path: z
        .string()
        .describe("Path on brightspace.vanderbilt.edu, e.g. /d2l/home or /d2l/home/{orgUnitId}"),
      maxChars: z.number().optional().describe("Text bound (default 8000)"),
    }),
    output: z.object({
      status: z.number(),
      finalUrl: z.string(),
      title: z.string(),
      text: z.string(),
      trace: z.array(z.string()),
    }),
    requires: ["net", "secret"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async ({ path, maxChars }, ctx) => {
      const store = vaultStore(ctx);
      const client = () => new BrightspaceClient({ cookies: store.cookies("vanderbilt") });
      await ensureSession("vanderbilt", store);
      try {
        return await client().fetchPage(path, maxChars);
      } catch (e) {
        // Re-mint once, but only when the failure is auth-shaped: a D2L 404 must not burn the
        // cached session (the ceremony needs a live browser hop).
        const msg = e instanceof Error ? e.message : String(e);
        const authShaped =
          e instanceof BrightspaceNotConfiguredError || /\b(401|403)\b|login|sso|auth|dance/i.test(msg);
        if (!authShaped) throw e;
        await store.forget("vanderbilt");
        await ensureSession("vanderbilt", store);
        return await client().fetchPage(path, maxChars);
      }
    },
  }),
  operation({
    name: "brightspace.api",
    description:
      "Authenticated GET of a D2L JSON API route on brightspace.vanderbilt.edu riding the cached vanderbilt session (establishes the SSO dance first, then GETs with the page-derived XSRF token kept internal). Returns status, final URL and the raw JSON text (bounded). Read-only: GET-only, entry URL pinned, no D2L write route is reachable.",
    input: z.object({
      path: z
        .string()
        .describe("API path on brightspace.vanderbilt.edu, e.g. /d2l/api/lp/1.44/enrollments/myenrollments/"),
      maxChars: z.number().optional().describe("Response text bound (default 16000)"),
    }),
    output: z.object({
      status: z.number(),
      contentType: z.string(),
      text: z.string(),
      finalUrl: z.string(),
      trace: z.array(z.string()),
    }),
    requires: ["net", "secret"],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async ({ path, maxChars }, ctx) => {
      const store = vaultStore(ctx);
      const client = () => new BrightspaceClient({ cookies: store.cookies("vanderbilt") });
      await ensureSession("vanderbilt", store);
      try {
        return await client().fetchApi(path, maxChars);
      } catch (e) {
        // Re-mint once on auth-shaped failures only (a D2L 404 must not burn the session).
        const msg = e instanceof Error ? e.message : String(e);
        const authShaped = e instanceof BrightspaceNotConfiguredError || /\b(401|403)\b|login|sso|auth|dance/i.test(msg);
        if (!authShaped) throw e;
        await store.forget("vanderbilt");
        await ensureSession("vanderbilt", store);
        return await client().fetchApi(path, maxChars);
      }
    },
  }),
  operation({
    name: "grades.whatif",
    description:
      "Pure GPA projection: apply hypothetical grades onto a transcript (replaces posted grades, fills unposted ones) and report per-term and cumulative GPAs.",
    input: z.object({
      transcript: transcriptSchema,
      hypotheticals: z
        .array(z.object({ course: z.string(), grade: z.string() }))
        .default([]),
    }),
    output: z.object({
      terms: z.array(
        z.object({
          term: z.string(),
          gpa: z.number().nullable(),
          gpaCredits: z.number(),
          qualityPoints: z.number(),
          changed: z.boolean(),
        }),
      ),
      cumulative: z.number().nullable(),
      cumulativeGpaCredits: z.number(),
      cumulativeQualityPoints: z.number(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: async ({ transcript, hypotheticals }) => whatIf(transcript, hypotheticals),
  }),
  operation({
    name: "gpa.verify",
    description:
      "The golden anchor: recompute term and cumulative GPAs from posted marks and compare against Vanderbilt's independent posted totals. Missing cumulative anchors are explicitly unverified. Run before trusting any what-if output. Defaults to the synthetic fixture; pass a live transcript to verify the real YES mapping.",
    input: z.object({ transcript: transcriptSchema.optional() }),
    output: z.object({
      ok: z.boolean(),
      rows: z.array(
        z.object({
          term: z.string(),
          posted: z.number(),
          recomputed: z.number().nullable(),
          match: z.boolean(),
        }),
      ),
      cumulative: z.number().nullable(),
      cumulativeCheck: z.object({ posted: z.number().nullable(), recomputed: z.number().nullable(), match: z.boolean().nullable() }),
      note: z.string(),
    }),
    annotations: { readOnlyHint: true },
    handler: async ({ transcript }) => verifyTranscript(transcript ?? SYNTHETIC_TRANSCRIPT),
  }),
];
