import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeSecrets } from "./credential-store.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.FAKE_GATEWAY_PORT;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native secret write boundary", () => {
  it("keeps the process event loop free while the CLI calls back into the gateway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vutoolkit-native-write-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const received: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received.push(body);
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const port = address.port;
    const cli = `#!/usr/bin/env node
if (process.argv.join(" ").includes("synthetic-private-envelope")) process.exit(9);
const http = require("node:http");
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const request = http.request({
    host: "127.0.0.1",
    port: Number(process.env.FAKE_GATEWAY_PORT),
    path: "/secrets.store.set",
    method: "POST",
    timeout: 1500,
  }, (response) => {
    response.resume();
    response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
  });
  request.on("timeout", () => { request.destroy(); process.exit(1); });
  request.on("error", () => process.exit(1));
  request.end(body);
});
`;
    writeFileSync(join(bin, "openclaw"), cli, { mode: 0o755 });
    process.env.PATH = bin + ":" + (originalPath ?? "");
    process.env.FAKE_GATEWAY_PORT = String(port);
    try {
      await nativeSecrets.write("SYNTHETIC_CACHE", "synthetic-private-envelope");
      expect(received).toEqual(["synthetic-private-envelope"]);
      expect(existsSync(join(dir, "sessions.vault.json"))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("fails closed when the CLI cannot persist the value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vutoolkit-native-write-fail-"));
    dirs.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "openclaw"), "#!/usr/bin/env node\nprocess.exit(2);\n", { mode: 0o755 });
    process.env.PATH = bin + ":" + (originalPath ?? "");
    await expect(nativeSecrets.write("SYNTHETIC_CACHE", "synthetic-private-envelope")).rejects.toThrow(
      "Native credential vault write failed; no credential was written to a cache file.",
    );
    expect(existsSync(join(dir, "sessions.vault.json"))).toBe(false);
  }, 10_000);
});
