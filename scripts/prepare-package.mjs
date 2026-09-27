import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// npm's explicit files list includes dist recursively; a nested ignore file
// prevents old release archives and compiled tests from shipping inside it.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("../dist/.npmignore", import.meta.url),
  "release/\n**/*.test.js\n**/*.test.d.ts\n**/*.spec.js\n**/*.spec.d.ts\n");
