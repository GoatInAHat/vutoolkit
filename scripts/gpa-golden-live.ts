/**
 * Live evidence harness for the GPA golden-test chain. Entry point: `scripts/gpa-golden-live.mjs`
 * (which re-execs this module under tsx). Proves, against the real account and the account
 * holder's own vault:
 *
 * 1. record.fetch's chain — ensureSession("vanderbilt") -> YesClient.academicRecord() — returns a
 *    live Transcript carrying Vanderbilt's own posted term and cumulative GPA anchors.
 * 2. gpa.verify's engine (verifyTranscript) recomputes every posted term GPA and the posted
 *    cumulative GPA, matching Vanderbilt's own numbers exactly.
 * 3. grades.whatif's engine (whatIf) projects a semester/cumulative GPA for every unposted,
 *    in-progress course assigned a hypothetical "A", without mutating the source transcript.
 *
 * Uses a temporary VUTOOLKIT_DATA_DIR under the OS temp dir seeded from the account holder's own
 * vaulted "vanderbilt" row, so nothing in the real session vault is read for writing or
 * overwritten. Prints booleans, counts and typed failure codes only — never transcript, cookie,
 * or token values.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "../src/sso/ensure.js";
import { sessionStore } from "../src/vault/file-store.js";
import { YesClient } from "../src/yes/client.js";
import { verifyTranscript, whatIf, type Transcript } from "../src/gpa/engine.js";

const env: NodeJS.ProcessEnv = { ...process.env };
delete env.VITEST; // OpenClaw's CLI skips its entrypoint under VITEST; this is a real vault read.

/**
 * The CLI is on PATH for an interactive shell but not for every exec wrapper; fall back to the
 * conventional install location so the harness reports a vault failure, not a spawn ENOENT.
 */
function openclawBin(): string {
  for (const candidate of ["openclaw", join(homedir(), ".openclaw", "bin", "openclaw")]) {
    try {
      execFileSync(candidate, ["--version"], { env, stdio: "ignore", timeout: 20_000 });
      return candidate;
    } catch (error) {
      const e = error as { code?: string; status?: number | null };
      if (e?.code !== "ENOENT" && e?.status !== null && e?.status !== undefined) return candidate;
    }
  }
  return "openclaw";
}

const CLI = openclawBin();
if (CLI !== "openclaw") {
  const cliDir = join(CLI, "..");
  if (!env.PATH!.split(":").includes(cliDir)) env.PATH = cliDir + ":" + env.PATH;
  process.env.PATH = env.PATH;
}

const secret = (name: string): string =>
  execFileSync(CLI, ["secrets", "store", "get", name, "--plain"], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000,
  }).trim();

// The email is optional input here (the vaulted cookies carry identity); absence must not abort
// the run before the record/verify/what-if evidence is collected.
let email: string | undefined;
try {
  email = env.VUTOOLKIT_VU_EMAIL || secret("VANDERBILT_EMAIL");
} catch {
  email = undefined;
}
const vuDeps = email ? { env: { ...env, VUTOOLKIT_VU_EMAIL: email } } : {};

let ok = true;
let failure: string | undefined;
const fail = (code: string) => { ok = false; failure ??= code; };

const dataDir = mkdtempSync(join(tmpdir(), "vutoolkit-gpa-golden-live-"));
const store = sessionStore(dataDir, { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });

// Seed the throwaway vault from the account holder's own vaulted vanderbilt row so the run
// proves the real chain. Nothing is written back to the real vault.
const realDataDir = env.VUTOOLKIT_DATA_DIR ?? join(homedir(), ".local", "share", "vutoolkit");
const vaulted = sessionStore(realDataDir, { ...env, VUTOOLKIT_CREDENTIAL_STORE: "file" });
let seeded = false;
const vaultedRow = await vaulted.get("vanderbilt");
// An empty seed would prove nothing about the cache path; fail closed instead of minting fresh.
if (!vaultedRow) {
  fail("SEED_INCOMPLETE");
} else {
  await store.put({ ...vaultedRow, cookies: vaulted.cookies("vanderbilt") });
  seeded = true;
}

let verify: { rowCount: number; allMatch: boolean; cumulativeMatch: boolean } | undefined;
let whatIfLog: { cumulative: number | null; gpaCredits: number; changedTermCount: number } | undefined;

try {
  if (seeded) {
    // 1 — record.fetch's own chain: ensure the cached session, then pull the live transcript.
    await ensureSession("vanderbilt", store, vuDeps);
    const transcript: Transcript = await new YesClient({ cookies: store.cookies("vanderbilt") }).academicRecord();
    const hasAnchors = transcript.terms.length > 0 &&
      transcript.terms.some((term) => term.postedGpa !== undefined) &&
      typeof transcript.postedCumulativeGpa === "number";
    if (!hasAnchors) {
      fail("RECORD_MISSING_POSTED_ANCHORS");
    } else {
      // 2 — gpa.verify's engine must reproduce every posted term and cumulative GPA.
      const verifyResult = verifyTranscript(transcript);
      verify = {
        rowCount: verifyResult.rows.length,
        allMatch: verifyResult.rows.every((row) => row.match),
        cumulativeMatch: verifyResult.cumulativeCheck.match === true,
      };
      if (!(verifyResult.ok === true && verify.allMatch && verify.cumulativeMatch)) fail("GPA_VERIFY_MISMATCH");

      // 3 — grades.whatif's engine must project a valid GPA and never mutate its input.
      const before = JSON.stringify(transcript);
      const hypotheticals = transcript.terms
        .flatMap((term) => term.courses)
        .filter((course) => course.grade === undefined)
        .map((course) => ({ course: course.course, grade: "A" }));
      const projection = whatIf(transcript, hypotheticals);
      const after = JSON.stringify(transcript);

      // Null cumulative is only valid when truly zero GPA-bearing credits fed the calculation.
      const validCumulative = projection.cumulative === null
        ? projection.cumulativeGpaCredits === 0
        : Number.isFinite(projection.cumulative) && projection.cumulative >= 0 && projection.cumulative <= 4;
      if (!validCumulative) fail("WHATIF_INVALID_PROJECTION");
      if (after !== before) fail("WHATIF_MUTATED_SOURCE");

      whatIfLog = {
        cumulative: projection.cumulative,
        gpaCredits: projection.cumulativeGpaCredits,
        changedTermCount: projection.terms.filter((term) => term.changed).length,
      };
    }
  }
} catch (error) {
  // Typed codes only: never message text, which could quote transcript or vault material.
  const e = error as { code?: string; name?: string };
  fail(String(e?.code ?? e?.name ?? "Error"));
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  ok,
  seeded,
  verify: verify ?? { rowCount: 0, allMatch: false, cumulativeMatch: false },
  whatIf: whatIfLog ?? { cumulative: null, gpaCredits: 0, changedTermCount: 0 },
  ...(failure ? { failure } : {}),
}));
process.exitCode = ok ? 0 : 1;
