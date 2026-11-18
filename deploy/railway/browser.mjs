// A browser signed in to the student's Vanderbilt and Microsoft accounts, offered through the same
// MCP endpoint as the rest of vutoolkit. The browsing is Microsoft's Playwright MCP server, run
// in-process with its own headless Chromium; this file only (1) loads vutoolkit's stored sessions
// into that browser and, when a site sends the browser to a sign-in page, finishes that sign-in in
// the background (src/sso/browser-session.ts), re-minting with the toolkit passkey where needed,
// and (2) offers Playwright's tools as `browser.*` operations. Session values stay in
// this process: the tools that read or set cookies and storage, and the one that runs arbitrary
// Playwright code, are not offered, and cookie or authorization header lines are redacted from
// every result. YES pages are read-only: yes-guard-page.cjs refuses enrollment and cart or
// planner requests.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
/** Sessions are reloaded into the browser at most this often unless a page proves one dead. */
const RELOAD_MS = 30 * 60_000;

/**
 * @param {object} deps
 * @param {typeof import("zod").z} deps.z  the zod the MCP server registers schemas with
 * @param {(idp: string, store: any, opts?: object) => Promise<unknown>} deps.ensureSession
 * @param {typeof import("../../dist/sso/browser-session.js")} deps.browserSession
 * @param {() => string} deps.email  the Vanderbilt account the browser holds
 * @param {() => any} deps.store  the session store
 * @param {string} deps.dataDir
 * @param {(message: string) => void} deps.log
 */
export async function browserOperations({ z, ensureSession, browserSession, email, store, dataDir, log }) {
  const { mergeStorageState, navigateSignedIn } = browserSession;
  const dir = join(dataDir, "browser");
  const outputDir = join(dir, "output");
  // Playwright MCP reads files only inside its output directory; the file is removed once loaded.
  const stateFile = join(outputDir, "storage-state.json");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });

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
      // YES stays read-only in the browser too (src/yes/guard.ts).
      initPage: [fileURLToPath(new URL("./yes-guard-page.cjs", import.meta.url))],
    },
    capabilities: ["core", "core-tabs", "core-navigation", "core-input", "storage", "network"],
    outputDir,
    imageResponses: "omit",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "vutoolkit-browser", version: "1" });
  await client.connect(clientSide);

  /**
   * Ensure the sessions (re-minting `force`d ones), then load them into the browser. The sign-in
   * hosts' cookies are replaced; the browser's other cookies and local storage are kept, because
   * that is where Outlook keeps its own sign-in.
   */
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
    let current;
    try {
      const saved = await client.callTool({ name: "browser_storage_state", arguments: { filename: stateFile } });
      if (!saved.isError) current = JSON.parse(readFileSync(stateFile, "utf8"));
    } catch { /* nothing to keep */ } finally {
      rmSync(stateFile, { force: true });
    }
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(mergeStorageState(current, cookies)), { mode: 0o600 });
    renameSync(`${stateFile}.tmp`, stateFile);
    let set;
    try {
      set = await client.callTool({ name: "browser_set_storage_state", arguments: { filename: stateFile } });
    } finally {
      rmSync(stateFile, { force: true });
    }
    if (set.isError) throw new Error(`could not load the stored sessions into the browser: ${text(set).replace(/^#+.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 300)}`);
  }

  let loadedAt = 0;
  let queue = Promise.resolve();
  const text = (result) => (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: text(result), isError: !!result.isError };
  };
  /** The page's evaluation result, or null when it could not run (mid-navigation, no page). */
  const evaluate = async (expression) => {
    const { text: out, isError } = await call("browser_evaluate", { function: expression });
    const json = /### Result\n([\s\S]*?)(?:\n### |$)/.exec(out)?.[1];
    if (isError || json === undefined) return null;
    try { return JSON.parse(json); } catch { return null; }
  };
  const reload = async (force = []) => {
    await loadSessions(force);
    loadedAt = Date.now();
  };
  // A page that lands on a sign-in host, at once or seconds later by script (Outlook), is signed in
  // again in the background and opened again; see src/sso/browser-session.ts.
  const driver = {
    navigate: (url) => call("browser_navigate", { url }),
    snapshot: () => call("browser_snapshot", {}),
    evaluate,
    reload,
    email,
    log,
  };

  async function run(name, args) {
    if (Date.now() - loadedAt > RELOAD_MS) await reload();
    if (name === "browser_navigate") return navigateSignedIn(driver, args.url);
    return call(name, args);
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
        const pending = queue.then(() => run(tool.name, args));
        queue = pending.catch(() => {});
        return pending.then((result) => {
          const body = result.text.replace(SECRET_LINE, "$1[redacted]");
          if (result.isError) throw new Error(body || `${tool.name} failed`);
          return { text: body };
        });
      },
    }));
}
