/**
 * Entry point for the ensure / session-cache / injection live harness.
 *
 * Node 22 cannot import `.ts` without a loader (`ERR_UNKNOWN_FILE_EXTENSION`), and tsx refuses
 * `module.register()` ("tsx must be loaded with --import instead of --loader"). So this shim
 * re-execs itself under `--import tsx` once and then loads the typed harness. It keeps the plan's
 * plain invocation — `node scripts/sso-ensure-live.mjs` — working with no extra flags.
 *
 * Usage: `node scripts/sso-ensure-live.mjs` (add VUTOOLKIT_DEBUG=1 for stage timings on stderr).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const REENTRY_FLAG = "VUTOOLKIT_ENSURE_LIVE_TSX";

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

await import(join(dirname(self), "ensure-live.ts"));
