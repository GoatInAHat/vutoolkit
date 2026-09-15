/**
 * vutoolkit's operations: pure functions of (JSON arguments, environment/config, filesystem).
 * Host-provided capabilities are declared with `requires`; toolfactory decides per surface
 * whether each operation is native, bridged, degraded, or excluded. Anything touching session
 * values or passkey material goes through the vault contract (src/vault/index.ts) and is
 * honestly gated until their wiring lands. sessions.ingest/open/list/forget are wired through
 * the file-backed FileSessionStore; sessions.refresh stays gated until the SecretLoader binding
 * plus browser ceremony land on the host side.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { cumulative, round3, whatIf, type Transcript } from "./gpa/engine.js";
import { SYNTHETIC_TRANSCRIPT } from "./gpa/fixtures.js";
import { YesClient } from "./yes/client.js";
import { vaultNotWired } from "./vault/index.js";
import { FileSessionStore, harvestToStoredSession } from "./vault/file-store.js";
import { operation, type Context } from "./toolfactory/types.js";

const transcriptSchema = z.object({
  terms: z.array(
    z.object({
      term: z.string(),
      postedGpa: z.number().optional(),
      courses: z.array(
        z.object({
          course: z.string(),
          credits: z.number(),
          grade: z.string().optional(),
        }),
      ),
    }),
  ),
});
type TranscriptArgs = z.infer<typeof transcriptSchema>;

/** The session vault: one 0600 JSON file in the tool's data dir, values never in tool output. */
const vaultStore = (ctx: Context): FileSessionStore => new FileSessionStore(join(ctx.dataDir, "sessions.vault.json"));

export const operations = [
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
    requires: ["secret"],
    handler: async ({ idp, format }, ctx) => {
      const store = vaultStore(ctx);
      const session = await store.get(idp);
      if (!session) throw vaultNotWired(`sessions.open(${idp}): no stored session — run sessions.ingest first`);
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
      "Run the OneVU passkey ceremony (CDP virtual authenticator holding the vaulted credential) and re-vault the fresh session. Credential material arrives via SecretRef — extracted or born-virtual, same contract.",
    input: z.object({
      idp: z.enum(["vanderbilt"]).default("vanderbilt"),
      startUrl: z.url().default("https://onevu.vanderbilt.edu"),
      secretRef: z.string().optional().describe("SecretRef holding PasskeyMaterialV1 JSON"),
      headless: z.boolean().default(true),
    }),
    output: z.object({ acquiredAt: z.string(), expiresAt: z.string().optional() }),
    requires: ["secret", "browser", "net"],
    handler: async ({ idp }) => vaultNotWired(`sessions.refresh(${idp}) passkey material resolution`),
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
      "Ingest a harvested browser cookie export into the session vault: keeps only cookies in the IdP's domain scope, stores values under the tool data dir (0600), and reports metadata only. The harvest itself is produced by the host browser outside this toolkit.",
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
    name: "record.fetch",
    description:
      "The YES academic record: posted terms plus in-progress unposted courses. Fixture mode for development and tests; live mode gated on credentials.",
    input: z.object({
      fixturePath: z
        .string()
        .optional()
        .describe("Read the transcript from this JSON file instead of live YES (dev/test)"),
    }),
    output: z.object({ transcript: transcriptSchema, source: z.enum(["fixture", "live"]) }),
    requires: ["net", "secret"],
    handler: async ({ fixturePath }) => {
      if (fixturePath) {
        const transcript = JSON.parse(readFileSync(fixturePath, "utf8")) as TranscriptArgs;
        return { transcript, source: "fixture" as const };
      }
      const transcript = await new YesClient().academicRecord();
      return { transcript, source: "live" as const };
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
      "The golden anchor: recompute per-term GPAs from posted marks and compare against the numbers Vanderbilt posted. Run before trusting any what-if output. Defaults to the synthetic fixture; pass a live transcript to lock the real YES mapping.",
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
      note: z.string(),
    }),
    annotations: { readOnlyHint: true },
    handler: async ({ transcript }) => {
      const t: Transcript = transcript ?? SYNTHETIC_TRANSCRIPT;
      const rows: { term: string; posted: number; recomputed: number | null; match: boolean }[] = [];
      for (const term of t.terms) {
        if (term.postedGpa === undefined) continue;
        const recomputed = round3(whatIf({ terms: [term] }, []).terms[0]?.gpa ?? null);
        const match = recomputed !== null && Math.abs(recomputed - term.postedGpa) <= 0.0005;
        rows.push({ term: term.term, posted: term.postedGpa, recomputed, match });
      }
      const ok = rows.length > 0 && rows.every((r) => r.match);
      return {
        ok,
        rows,
        cumulative: round3(cumulative(t)),
        note: ok
          ? "all posted GPAs reproduced — the engine's scale semantics hold"
          : "MISMATCH: do not trust what-if output until the scale mapping is corrected",
      };
    },
  }),
];
