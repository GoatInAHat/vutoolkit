/**
 * Entry point for the GPA golden-test live harness (record.fetch -> gpa.verify -> grades.whatif).
 *
 * Node 22 cannot import `.ts` without a loader (`ERR_UNKNOWN_FILE_EXTENSION`), and tsx refuses
 * `module.register()` ("tsx must be loaded with --import instead of --loader"). So this shim
 * re-execs itself under `--import tsx` once and then loads the typed harness. It keeps the plan's
 * plain invocation — `node scripts/gpa-golden-live.mjs` — working with no extra flags.
 *
 * Usage: `node scripts/gpa-golden-live.mjs`
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const REENTRY_FLAG = "VUTOOLKIT_GPA_GOLDEN_LIVE_TSX";

if (!process.env[REENTRY_FLAG]) {
  const run = spawnSync(process.execPath, ["--import", "tsx", self], {
    stdio: "inherit",
    env: { ...process.env, [REENTRY_FLAG]: "1" },
    cwd: dirname(self),
  });
  if (run.error) {
    console.error(JSON.stringify({ ok: false, failure: "TSX_LOADER_UNAVAILABLE", detail: String(run.error.code ?? run.error.name) }));
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}

await import(join(dirname(self), "gpa-golden-live.ts"));
