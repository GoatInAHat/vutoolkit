#!/usr/bin/env node
// Stand-in for the two `openclaw secrets store` calls vutoolkit makes, for hosts without OpenClaw
// (a container on Railway). Values live in one 0600 JSON file on the persistent volume; `get`
// falls back to the environment variable of the same name, so VANDERBILT_EMAIL and friends can be
// set as ordinary service variables while the passkey counter and new enrollments persist here.
// Exit codes follow the real CLI: 3 = no such secret, 2 = unsupported command.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.VUTOOLKIT_SECRETS_FILE || "/data/secrets/vault.json";
const [group, sub, verb, name, ...rest] = process.argv.slice(2);
const load = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };

if (group === "secrets" && sub === "store" && verb === "get" && name) {
  const value = load()[name] ?? process.env[name];
  if (value === undefined || value === null || value === "") process.exit(3);
  process.stdout.write(String(value));
  process.exit(0);
} else if (group === "secrets" && sub === "store" && verb === "set" && name && rest.includes("-")) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const values = load();
    values[name] = input.replace(/\n$/, "");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(values), { mode: 0o600 });
    fs.renameSync(tmp, file);
    process.exit(0);
  });
} else {
  process.stderr.write("openclaw shim: only `secrets store get|set` is supported here\n");
  process.exit(2);
}
