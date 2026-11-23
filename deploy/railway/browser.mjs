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
//
// The browser is shared by every MCP client of this server, and the MCP endpoint is stateless (a
// fresh server per request, so there is no session to key on). So each caller works in a tab of its
// own, named by an id: browser.navigate without `tab` opens a new tab and returns its id, and every
// browser tool takes `tab` and runs in that tab, selected with Playwright MCP's own tab tool before
// the call. A call without `tab` is refused while more than one tab is open, rather than run in
// whichever tab another session left selected. All tabs share one browser context, so the sign-ins
// and Outlook's local storage are shared.
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
/** A tab unused this long is closed; past MAX_TABS the least recently used one is. */
const TAB_IDLE_MS = 30 * 60_000;
const MAX_TABS = 8;
const TAB_PARAM = {
  type: "string",
  description:
    'Your tab\'s id (e.g. "t3"), as browser.navigate returned it. This browser is shared with other sessions: pass it on every call so you work in your own tab. Omit it on browser.navigate to open a new tab.',
};

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
      // owa-page.cjs keeps Outlook's own token for the mail and calendar tools (src/owa).
      initPage: [fileURLToPath(new URL("./yes-guard-page.cjs", import.meta.url)), fileURLToPath(new URL("./owa-page.cjs", import.meta.url))],
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
    // The tool's contract is a function; Playwright MCP 0.0.85 also evaluates a bare expression,
    // but wrapping keeps to the documented form.
    const { text: out, isError } = await call("browser_evaluate", { function: `() => (${expression})` });
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

  // One tab per caller, by id. Pages come from the browser context Playwright MCP drives, which
  // owa-page.cjs (an initPage hook) records; Playwright MCP numbers its tabs in the order the
  // context opened them, which is context.pages()'s order.
  const tabs = new Map();
  let nextTab = 1;
  const browserContext = () => globalThis[OWA]?.context;
  const pages = () => browserContext()?.pages() ?? [];

  function adopt(page) {
    const id = `t${nextTab++}`;
    tabs.set(id, { page, usedAt: Date.now() });
    page.once("close", () => tabs.delete(id));
    return id;
  }

  async function closeTab(id) {
    const entry = tabs.get(id);
    tabs.delete(id);
    await entry?.page.close().catch(() => {});
  }

  async function sweep() {
    const now = Date.now();
    for (const [id, entry] of tabs) if (entry.page.isClosed() || now - entry.usedAt > TAB_IDLE_MS) await closeTab(id);
    while (tabs.size >= MAX_TABS) {
      const [oldest] = [...tabs].sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
      await closeTab(oldest);
    }
  }

  async function openTab() {
    await sweep();
    const before = new Set(pages());
    const opened = await call("browser_tabs", { action: "new" });
    if (opened.isError) throw new Error(`could not open a tab: ${opened.text.slice(0, 200)}`);
    // owa-page.cjs records the context once the page's initPage hooks ran; allow it a moment.
    let page;
    for (let waited = 0; !(page = pages().find((p) => !before.has(p) && !p.isClosed())) && waited < 5000; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!page) throw new Error("could not open a tab: the new page did not appear in the browser context");
    return adopt(page);
  }

  async function selectTab(id) {
    const entry = tabs.get(id);
    if (!entry || entry.page.isClosed()) {
      throw new Error(`Tab ${id} is not open (tabs close after ${TAB_IDLE_MS / 60_000} idle minutes). Call browser.navigate without tab to open a new one.`);
    }
    const index = pages().indexOf(entry.page);
    if (index < 0) throw new Error(`Tab ${id} is not in the browser any more. Call browser.navigate without tab to open a new one.`);
    const selected = await call("browser_tabs", { action: "select", index });
    if (selected.isError) throw new Error(`could not select tab ${id}: ${selected.text.slice(0, 200)}`);
    entry.usedAt = Date.now();
  }

  /** The caller's tab: theirs by id, a new one for a navigation, or the only one open. */
  async function resolveTab(name, tab) {
    if (tab !== undefined) return { id: tab, opened: false };
    if (name === "browser_navigate" || tabs.size === 0) return { id: await openTab(), opened: true };
    if (tabs.size === 1) return { id: [...tabs.keys()][0], opened: false };
    throw new Error(
      `${tabs.size} tabs are open in this shared browser (${[...tabs.keys()].join(", ")}), and other sessions may be using them. Pass tab with the id browser.navigate returned to you, or call browser.navigate without tab to open your own.`,
    );
  }

  const tabNote = (id, opened, popups) =>
    [
      "### Tab",
      opened ? `- ${id} (new): pass "tab": "${id}" on your next browser calls to keep working in this tab.` : `- ${id}`,
      ...popups.map((p) => `- ${p} opened from ${id} (a popup or new window): pass "tab": "${p}" to use it.`),
      "",
    ].join("\n");

  async function run(name, args) {
    if (Date.now() - loadedAt > RELOAD_MS) await reload();
    const { tab, ...rest } = args;
    const { id, opened } = await resolveTab(name, tab);
    await selectTab(id);
    const mine = tabs.get(id).page;
    const before = new Set(pages());
    const result = name === "browser_navigate" ? await navigateSignedIn(driver, rest.url) : await call(name, rest);
    // A page this tab opened (target=_blank, window.open) gets an id of its own.
    const popups = [];
    for (const page of pages()) {
      if (before.has(page) || page.isClosed() || [...tabs.values()].some((t) => t.page === page)) continue;
      if ((await page.opener().catch(() => null)) === mine) popups.push(adopt(page));
    }
    return { ...result, text: tabNote(id, opened, popups) + result.text };
  }

  /** browser.tabs on the caller's own tabs, by id. */
  async function tabsTool({ action, tab, url }) {
    if (Date.now() - loadedAt > RELOAD_MS) await reload();
    if (action === "new") {
      const id = await openTab();
      await selectTab(id);
      const result = url ? await navigateSignedIn(driver, url) : { text: "", isError: false };
      return { ...result, text: tabNote(id, true, []) + result.text };
    }
    if (action === "close") {
      if (!tab) throw new Error("browser.tabs close needs tab: the id of your own tab");
      if (!tabs.has(tab)) throw new Error(`Tab ${tab} is not open.`);
      await closeTab(tab);
      return { text: `Closed tab ${tab}.`, isError: false };
    }
    await sweep();
    const now = Date.now();
    const lines = [];
    for (const [id, entry] of tabs) {
      const title = await entry.page.title().catch(() => "");
      lines.push(`- ${id}: [${title}](${entry.page.url()}) (used ${Math.round((now - entry.usedAt) / 60_000)} min ago)`);
    }
    return { text: `### Tabs\n${lines.join("\n") || "No tabs open."}`, isError: false };
  }

  const owa = owaTransport({ call, driver, reload, navigateSignedIn, serialize: (task) => {
    const pending = queue.then(async () => {
      if (Date.now() - loadedAt > RELOAD_MS) await reload();
      return task();
    });
    queue = pending.catch(() => {});
    return pending;
  }, dataDir, log });

  const queued = (task) => {
    const pending = queue.then(task);
    queue = pending.catch(() => {});
    return pending.then((result) => {
      const body = result.text.replace(SECRET_LINE, "$1[redacted]");
      if (result.isError) throw new Error(body || "browser call failed");
      return { text: body };
    });
  };

  const { tools } = await client.listTools();
  const ops = tools
    .filter((tool) => !WITHHELD.test(tool.name) && tool.name !== "browser_tabs")
    .map((tool) => ({
      name: tool.name.replace(/^browser_/, "browser."),
      description: `${tool.description}. This browser is signed in to the student's Vanderbilt (OneVU, Brightspace, YES) and Microsoft 365 accounts and stays signed in.${
        tool.name === "browser_navigate" ? " Without tab it opens a new tab of your own and returns its id; pass that id as tab on every later browser call, since other sessions share this browser." : " Pass tab (from browser.navigate) so this runs in your own tab."
      }`,
      input: z.fromJSONSchema({ ...tool.inputSchema, properties: { ...(tool.inputSchema.properties ?? {}), tab: TAB_PARAM } }),
      output: z.object({ text: z.string() }),
      requires: ["net"],
      annotations: { readOnlyHint: tool.annotations?.readOnlyHint ?? false, destructiveHint: tool.annotations?.destructiveHint, openWorldHint: true },
      handler: (args) => queued(() => run(tool.name, args)),
    }));
  if (tools.some((tool) => tool.name === "browser_tabs")) {
    ops.push({
      name: "browser.tabs",
      description:
        "List your tabs in the signed-in browser, open a new one (optionally at url), or close one by its tab id. The browser is shared with other sessions; each works in its own tab, named by the id browser.navigate or this tool returns.",
      input: z.object({
        action: z.enum(["list", "new", "close"]).describe("list: the open tabs and their ids; new: open a tab of your own; close: close tab"),
        tab: z.string().optional().describe("The tab to close"),
        url: z.string().optional().describe("For new: the URL to open in it"),
      }),
      output: z.object({ text: z.string() }),
      requires: ["net"],
      annotations: { readOnlyHint: false, openWorldHint: true },
      handler: (args) => queued(() => tabsTool(args)),
    });
  }
  // The OWA transport rides along for server.mjs (src/owa/operations.ts).
  return Object.assign(ops, { owa });
}

const OWA = Symbol.for("vutoolkit.owa");
const OUTLOOK_MAIL = "https://outlook.cloud.microsoft/mail/";
/** A token this close to expiry is replaced before use. */
const OWA_MARGIN_MS = 5 * 60_000;
const OWA_WAIT_MS = 45_000;

/**
 * Outlook's bearer token for src/owa/client.ts, taken from the signed-in browser's own Outlook
 * requests (owa-page.cjs). When none is fresh enough, Outlook is opened in a background tab of the
 * same browser, signed in as browser.navigate would (re-minting sessions when Microsoft asks), and
 * its first service request supplies the token; the tab is then closed. The agent's own tab is not
 * touched. The token stays in this process and is never part of a tool result.
 */
function owaTransport({ call, driver, navigateSignedIn, serialize, dataDir, log }) {
  const shared = () => (globalThis[OWA] ??= { context: undefined, token: undefined, recorded: new Map(), listeners: new Set() });
  const recordedFile = join(dataDir, "browser", "owa-recorded.json");
  let persisted = {};
  try { persisted = JSON.parse(readFileSync(recordedFile, "utf8")); } catch { /* none yet */ }
  let savedCount = Object.keys(persisted).length;
  const save = () => {
    const all = { ...persisted, ...Object.fromEntries(shared().recorded) };
    if (Object.keys(all).length === savedCount) return;
    try {
      writeFileSync(`${recordedFile}.tmp`, JSON.stringify(all), { mode: 0o600 });
      renameSync(`${recordedFile}.tmp`, recordedFile);
      persisted = all;
      savedCount = Object.keys(all).length;
    } catch { /* best effort */ }
  };

  const usable = (t, fresh, since) => t && t.expiresAt - Date.now() > OWA_MARGIN_MS && (!fresh || t.capturedAt > since);

  async function capture(fresh, since) {
    const s = shared();
    if (usable(s.token, fresh, since)) return s.token;
    // Playwright MCP opens its browser on the first tool call that needs a page.
    if (!s.context) await call("browser_tabs", { action: "list" });
    if (!s.context) await call("browser_snapshot", {});
    if (!s.context) throw Object.assign(new Error("The signed-in browser is not running, so Outlook's token is unavailable."), { code: "OWA_NO_BROWSER" });
    const page = await s.context.newPage();
    let wake;
    const listener = () => wake?.();
    s.listeners.add(listener);
    try {
      const nav = async (url) => {
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
          return { text: `- Page URL: ${page.url()}\n- Page Title: ${await page.title().catch(() => "")}` };
        } catch (error) {
          return { text: `- Page URL: ${page.url()}\n${String(error?.message ?? error).split("\n")[0]}`, isError: true };
        }
      };
      const backgroundDriver = {
        ...driver,
        navigate: nav,
        snapshot: async () => ({ text: `- Page URL: ${page.url()}\n- Page Title: ${await page.title().catch(() => "")}` }),
        evaluate: (expression) => page.evaluate(`(${expression})`).catch(() => null),
      };
      const landed = await navigateSignedIn(backgroundDriver, OUTLOOK_MAIL);
      if (landed.isError) log(`owa: opening Outlook failed: ${landed.text.split("\n").slice(1).join(" ").slice(0, 200)}`);
      const deadline = Date.now() + OWA_WAIT_MS;
      while (!usable(s.token, true, since) && Date.now() < deadline) {
        await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 2000); });
      }
      if (!usable(s.token, true, since)) {
        throw Object.assign(new Error(`Outlook did not sign in in the browser (it ended on ${new URL(page.url()).origin}); browser.navigate to ${OUTLOOK_MAIL} shows why.`), { code: "OWA_NO_TOKEN" });
      }
      log("owa: took a fresh Outlook token from the signed-in browser");
      return s.token;
    } finally {
      s.listeners.delete(listener);
      await page.close().catch(() => {});
      save();
    }
  }

  return {
    /** A usable token; `fresh` (after a 401) insists on one newer than the one that failed. */
    async token(fresh) {
      const since = fresh ? shared().token?.capturedAt ?? 0 : 0;
      const t = shared().token;
      if (usable(t, false, 0) && !fresh) return t;
      return serialize(() => capture(fresh, since));
    },
    /** The request shape Outlook's own page sent for an action, when one was seen. */
    recorded(action) {
      save();
      return shared().recorded.get(action) ?? persisted[action];
    },
  };
}
