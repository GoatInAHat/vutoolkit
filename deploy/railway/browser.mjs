// A browser signed in to the student's Vanderbilt and Microsoft accounts, offered through the same
// MCP endpoint as the rest of vutoolkit. The browsing is Microsoft's Playwright MCP server, run
// in-process with its own headless Chromium; this file only (1) loads vutoolkit's stored sessions
// into that browser and re-mints them with the toolkit passkey when a site sends the browser to a
// sign-in page, and (2) offers Playwright's tools as `browser.*` operations. Session values stay in
// this process: the tools that read or set cookies and storage, and the one that runs arbitrary
// Playwright code, are not offered, and cookie or authorization header lines are redacted from
// every result.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const local = createRequire(import.meta.url);
const dep = (name) => import(local.resolve(name));

/**
 * Not offered: session material and arbitrary code (cookies, storage, run_code_unsafe); tools whose
 * output is a file on this server the agent cannot read (screenshots, PDFs, uploads from server
 * paths); and test-harness controls with no use on a real account (request mocking, offline mode,
 * media emulation).
 */
const WITHHELD = /^browser_(?:run_code_unsafe|storage_state|set_storage_state|cookie_\w+|localstorage_\w+|sessionstorage_\w+|take_screenshot|pdf_save|file_upload|drop|route|route_list|unroute|network_state_set|emulate_media)$/;
const SECRET_LINE = /^(\s*["']?(?:cookie|set-cookie|authorization|x-csrf-token)["']?\s*:\s*).+$/gim;
/** Where a dead session sends the browser, and whose session it was. */
const SIGN_IN = [
  { host: "onevu.vanderbilt.edu", idp: "vanderbilt" },
  { host: "login.microsoftonline.com", idp: "microsoft" },
  { host: "login.microsoft.com", idp: "microsoft" },
];
/** Sessions are reloaded into the browser at most this often unless a page proves one dead. */
const RELOAD_MS = 30 * 60_000;

/**
 * @param {object} deps
 * @param {typeof import("zod").z} deps.z  the zod the MCP server registers schemas with
 * @param {(idp: string, store: any, opts?: object) => Promise<unknown>} deps.ensureSession
 * @param {() => any} deps.store  the session store
 * @param {string} deps.dataDir
 * @param {(message: string) => void} deps.log
 */
export async function browserOperations({ z, ensureSession, store, dataDir, log }) {
  const dir = join(dataDir, "browser");
  const stateFile = join(dir, "storage-state.json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const { createConnection } = await dep("@playwright/mcp");
  const { Client } = await dep("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await dep("@modelcontextprotocol/sdk/inMemory.js");
  const server = await createConnection({
    browser: {
      browserName: "chromium",
      isolated: true,
      launchOptions: {
        headless: true,
        executablePath: process.env.VUTOOLKIT_BROWSER_EXECUTABLE || undefined,
        chromiumSandbox: false,
        args: ["--disable-dev-shm-usage"],
      },
    },
    capabilities: ["core", "core-tabs", "core-navigation", "core-input", "storage", "network"],
    outputDir: join(dir, "output"),
    imageResponses: "omit",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "vutoolkit-browser", version: "1" });
  await client.connect(clientSide);

  /** Ensure the sessions (re-minting `force`d ones), then load every stored cookie into the browser. */
  async function loadSessions(force = []) {
    const s = store();
    const cookies = [];
    for (const idp of ["vanderbilt", "microsoft"]) {
      try {
        await ensureSession(idp, s, force.includes(idp) ? { forceRefresh: true } : {});
      } catch (error) {
        log(`browser: ${idp} session unavailable (${error?.code ?? error?.name ?? "error"})`);
      }
      for (const c of s.cookies(idp)) {
        cookies.push({
          name: c.name, value: c.value, domain: c.domain, path: c.path ?? "/", expires: c.expires ?? -1,
          httpOnly: c.httpOnly ?? false, secure: c.secure ?? true, sameSite: c.sameSite ?? "Lax",
        });
      }
    }
    writeFileSync(`${stateFile}.tmp`, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
    renameSync(`${stateFile}.tmp`, stateFile);
    const set = await client.callTool({ name: "browser_set_storage_state", arguments: { filename: stateFile } });
    if (set.isError) throw new Error(`could not load the stored sessions into the browser: ${text(set).slice(0, 300)}`);
  }

  let loadedAt = 0;
  let queue = Promise.resolve();
  const text = (result) => (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const signInPage = (result) => {
    const url = /Page URL: (\S+)/.exec(text(result))?.[1];
    try { return url && SIGN_IN.find((s) => new URL(url).hostname === s.host); } catch { return undefined; }
  };

  async function run(name, args) {
    if (Date.now() - loadedAt > RELOAD_MS) {
      await loadSessions();
      loadedAt = Date.now();
    }
    let result = await client.callTool({ name, arguments: args });
    // A session that died since it was loaded sends the page to its sign-in host: re-mint it with
    // the toolkit passkey, reload the browser's cookies and open the page again, once.
    const landed = name === "browser_navigate" && signInPage(result);
    if (landed && !SIGN_IN.some((s) => s.host === new URL(args.url).hostname)) {
      log(`browser: ${landed.idp} session refused by the site; re-minting`);
      await loadSessions([landed.idp]);
      loadedAt = Date.now();
      result = await client.callTool({ name, arguments: args });
    }
    return result;
  }

  const { tools } = await client.listTools();
  return tools
    .filter((tool) => !WITHHELD.test(tool.name))
    .map((tool) => ({
      name: tool.name.replace(/^browser_/, "browser."),
      description: `${tool.description}. This browser is signed in to the student's Vanderbilt (OneVU, Brightspace, YES) and Microsoft 365 accounts and stays signed in.`,
      input: z.fromJSONSchema(tool.inputSchema),
      output: z.object({ text: z.string() }),
      requires: ["net"],
      annotations: { readOnlyHint: tool.annotations?.readOnlyHint ?? false, destructiveHint: tool.annotations?.destructiveHint, openWorldHint: true },
      handler: (args) => {
        const call = queue.then(() => run(tool.name, args));
        queue = call.catch(() => {});
        return call.then((result) => {
          const body = text(result).replace(SECRET_LINE, "$1[redacted]");
          if (result.isError) throw new Error(body || `${tool.name} failed`);
          return { text: body };
        });
      },
    }));
}
