/** Native Tool Factory T4 entrypoint; existing host-vault auth stays inside the operations. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync(process.execPath, [
  "--env-file-if-exists=.env", "node_modules/vitest/vitest.mjs", "run", "tests/live.test.ts", "tests/yes-live.test.ts",
  ...process.argv.slice(2),
], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VUTOOLKIT_LIVE: "1" },
});
process.exitCode = result.status ?? 1;
