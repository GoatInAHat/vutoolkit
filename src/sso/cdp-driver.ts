/**
 * Minimal CDP tab driver shared by the SSO ceremonies: opens the ceremony's own tab, wires a
 * send/evaluate channel, and always closes the tab. Cookie and key material never leaves the
 * caller's memory — nothing here logs or echoes values.
 */
export interface CdpTab {
  send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  evaluate: (expression: string) => Promise<unknown>;
  tabId: string;
}

/** Gateway proxy env breaks loopback CDP fetches; bypass only for loopback, keep egress proxy. */
export function augmentNoProxy(env: NodeJS.ProcessEnv = process.env): void {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const current = env[key] ?? "";
    if (!/(^|,)(127\.0\.0\.1|localhost)(,|$)/.test(current)) {
      env[key] = current ? current + ",127.0.0.1,localhost" : "127.0.0.1,localhost";
    }
  }
}

/** Loopback CDP answers in milliseconds; these bounds only stop a dead browser from hanging a tool call. */
const HTTP_TIMEOUT_MS = 10_000;
const WS_OPEN_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 30_000;

/**
 * Open the ceremony's own tab, run fn with a send/evaluate channel, close the tab afterwards.
 * Navigation wait is the caller's job (poll location.href) — pages differ too much for a fixed
 * ready signal to be honest. Every CDP round-trip is bounded: a browser that dies mid-ceremony
 * rejects pending calls instead of leaving the caller waiting forever.
 */
export async function withCdpTab<T>(
  cdpUrl: string,
  startUrl: string,
  fn: (tab: CdpTab) => Promise<T>,
): Promise<T> {
  augmentNoProxy();
  const blank = await fetch(new URL("/json/new?" + startUrl, cdpUrl), {
    method: "PUT",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!blank.ok) throw new Error("ceremony could not open a tab (HTTP " + blank.status + ")");
  const tab = (await blank.json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map<number, { settle: (m: { id?: number; error?: unknown; result?: unknown }) => void; fail: (e: Error) => void }>();
  const failAll = (reason: string): void => {
    for (const entry of pending.values()) entry.fail(new Error(reason));
    pending.clear();
  };
  try {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("ceremony CDP websocket did not open")), WS_OPEN_TIMEOUT_MS);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error("ceremony CDP websocket failed")); };
    });
    ws.onclose = () => failAll("ceremony CDP websocket closed");
    ws.onerror = () => failAll("ceremony CDP websocket failed");
    let mid = 0;
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { id?: number; error?: unknown; result?: unknown };
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)!.settle(m);
          pending.delete(m.id);
        }
      } catch { /* non-JSON frames are events; ignored */ }
    };
    const send = <R = unknown>(method: string, params: Record<string, unknown> = {}): Promise<R> =>
      new Promise((res, rej) => {
        const id = ++mid;
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error("ceremony: " + method + " timed out"));
        }, SEND_TIMEOUT_MS);
        pending.set(id, {
          settle: (m) => {
            clearTimeout(timer);
            if (m.error) rej(new Error("ceremony: " + method + " failed"));
            else res(m.result as R);
          },
          fail: (e) => { clearTimeout(timer); rej(e); },
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          rej(new Error("ceremony: " + method + " could not be sent"));
        }
      });
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return r.result?.value;
    };
    return await fn({ send, evaluate, tabId: tab.id });
  } finally {
    ws.onclose = null;
    failAll("ceremony finished");
    ws.close();
    try {
      await fetch(new URL("/json/close/" + tab.id, cdpUrl), { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch { /* tab cleanup best-effort */ }
  }
}

/** Whether a CDP endpoint answers /json/version; never throws. */
export async function cdpReachable(cdpUrl: string, timeoutMs = 2500): Promise<boolean> {
  augmentNoProxy();
  try {
    const res = await fetch(new URL("/json/version", cdpUrl), { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Every cookie the browser holds at call time, mapped to the vault's record shape. */
export async function harvestCookies(send: CdpTab["send"]): Promise<Array<{ name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }>> {
  const storage = await send<{ cookies: Array<Record<string, unknown>> }>("Storage.getCookies", {});
  return storage.cookies.map((c) => ({
    name: String(c.name),
    value: String(c.value),
    domain: String(c.domain ?? ""),
    path: typeof c.path === "string" ? c.path : undefined,
    expires: typeof c.expires === "number" ? c.expires : undefined,
    httpOnly: typeof c.httpOnly === "boolean" ? c.httpOnly : undefined,
    secure: typeof c.secure === "boolean" ? c.secure : undefined,
    sameSite: typeof c.sameSite === "string" ? c.sameSite : undefined,
  }));
}

/** Native value fill so React/SPA inputs register the change; returns false when absent. */
export const FILL_NATIVE = "(sel,val)=>{const el=document.querySelector(sel);if(!el)return false;" +
  "const d=Object.getOwnPropertyDescriptor(el.constructor.prototype,'value');d.set.call(el,val);" +
  "el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}";

/** Click only when the control actually renders; returns false when absent or hidden. */
export const CLICK_VISIBLE = "(s=>{const e=document.querySelector(s);if(!e||!(e.offsetParent||e.getClientRects().length))return false;e.click();return true;})";
