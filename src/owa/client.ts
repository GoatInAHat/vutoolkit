/**
 * The OWA client: Outlook on the web's own JSON service (outlook.cloud.microsoft/owa/service.svc),
 * called with the bearer token Outlook's page already holds. vutoolkit's sign-in is the only auth
 * it uses: there is no Graph app and no OAuth client of the toolkit's own. The Railway kit's
 * signed-in browser supplies the token (deploy/railway/browser.mjs); this module only shapes
 * requests, sends them and retries once on a fresh token when the service says 401.
 */

/** What a request needs from the signed-in browser. The token itself never leaves the server. */
export interface OwaToken {
  token: string;
  /** Outlook's origin the token was used on, e.g. https://outlook.cloud.microsoft */
  origin: string;
  /** Outlook's routing hint for the mailbox (x-anchormailbox), when the page sent one. */
  anchorMailbox?: string;
  /** Epoch milliseconds the token stops working. */
  expiresAt: number;
}

export interface OwaTransport {
  /** A usable token; `fresh` asks for a new one (after a 401), running the background re-auth if needed. */
  token(fresh: boolean): Promise<OwaToken>;
  fetch?: typeof fetch;
}

export class OwaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OwaError";
  }
}

/** Windows time zone Outlook reports times in when the caller names none. */
export const DEFAULT_TIME_ZONE = "Central Standard Time";
/** The request schema version Outlook on the web itself sends. */
export const REQUEST_SERVER_VERSION = "V2018_01_08";

const ACTION = /^[A-Za-z][A-Za-z0-9]{1,80}$/;

export function assertActionName(action: string): void {
  if (!ACTION.test(action)) throw new OwaError("OWA_BAD_ACTION", `"${action}" is not an Outlook action name (letters and digits, e.g. FindItem).`);
}

/** True when the value is already a whole OWA request ({Header, Body} or a typed envelope). */
export function isEnvelope(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const o = body as Record<string, unknown>;
  return "Body" in o && ("Header" in o || typeof o.__type === "string");
}

/**
 * OWA's request envelope around a request body:
 * {__type: "<Action>JsonRequest:#Exchange", Header: {...}, Body: {__type: "<Action>Request:#Exchange", ...body}}.
 * A body that already is an envelope is sent as given.
 */
export function envelope(action: string, body: unknown, opts: { timeZone?: string } = {}): unknown {
  if (isEnvelope(body)) return body;
  const inner = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  return {
    __type: `${action}JsonRequest:#Exchange`,
    Header: {
      __type: "JsonRequestHeaders:#Exchange",
      RequestServerVersion: REQUEST_SERVER_VERSION,
      TimeZoneContext: {
        __type: "TimeZoneContext:#Exchange",
        TimeZoneDefinition: { __type: "TimeZoneDefinitionType:#Exchange", Id: opts.timeZone ?? DEFAULT_TIME_ZONE },
      },
    },
    Body: { __type: `${action}Request:#Exchange`, ...inner },
  };
}

/** Drop OWA's `__type` markers so results read as plain data. */
export function stripTypes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripTypes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== "__type") out[k] = stripTypes(v);
    return out;
  }
  return value;
}

export interface OwaResult {
  status: number;
  body: unknown;
}

const RETRY_STATUSES = new Set([401, 440]);

/**
 * One OWA action. A 401 (or Outlook's 440 "login timeout") gets one retry on a fresh token, which
 * may run the browser's background Microsoft re-auth. Any other non-2xx status is an OwaError;
 * a 200 with ResponseClass "Error" items is returned as the service sent it.
 */
/** Actions Outlook serves from a path other than /owa/service.svc. */
export const ACTION_PATH: Record<string, string> = { GetTimeZoneOffsets: "/owa/published/service.svc" };

export async function owaCall(transport: OwaTransport, action: string, body: unknown, opts: { timeZone?: string; signal?: AbortSignal } = {}): Promise<OwaResult> {
  assertActionName(action);
  const doFetch = transport.fetch ?? fetch;
  const payload = JSON.stringify(envelope(action, body, opts));
  const send = async (token: OwaToken) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token.token}`,
      action,
      "content-type": "application/json; charset=utf-8",
      accept: "application/json",
      // Stable item and folder ids that survive moves, as Outlook's own page asks for.
      prefer: 'IdType="ImmutableId"',
      "x-req-source": "Mail",
    };
    if (token.anchorMailbox) headers["x-anchormailbox"] = token.anchorMailbox;
    return doFetch(`${token.origin}${ACTION_PATH[action] ?? "/owa/service.svc"}?action=${encodeURIComponent(action)}&app=Mail`, { method: "POST", headers, body: payload, signal: opts.signal });
  };
  let res = await send(await transport.token(false));
  if (RETRY_STATUSES.has(res.status)) res = await send(await transport.token(true));
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const detail = parsed && typeof parsed === "object" ? JSON.stringify(stripTypes((parsed as { Body?: unknown }).Body ?? parsed)) : text;
    if (RETRY_STATUSES.has(res.status)) {
      throw new OwaError("OWA_UNAUTHORIZED", `Outlook refused the request (${res.status}) even with a fresh token from the signed-in browser.`, res.status);
    }
    throw new OwaError("OWA_HTTP_ERROR", `Outlook answered ${res.status} for ${action}: ${detail.slice(0, 500)}`, res.status);
  }
  if (parsed === undefined) throw new OwaError("OWA_BAD_RESPONSE", `Outlook answered ${action} with something other than JSON.`, res.status);
  return { status: res.status, body: parsed };
}

/** The response messages of a standard OWA/EWS response. */
export function responseItems(body: unknown): Array<Record<string, unknown>> {
  const items = (body as { Body?: { ResponseMessages?: { Items?: unknown } } } | null)?.Body?.ResponseMessages?.Items;
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
}

/** Throws the first error response message as an OwaError; returns the messages otherwise. */
export function expectSuccess(action: string, body: unknown): Array<Record<string, unknown>> {
  const items = responseItems(body);
  const failed = items.find((i) => i.ResponseClass === "Error");
  if (failed) throw new OwaError(String(failed.ResponseCode ?? "OWA_ERROR"), `${action} failed: ${String(failed.MessageText ?? failed.ResponseCode ?? "error")}`);
  return items;
}

/** Epoch ms a JWT expires, or undefined when the token is not a readable JWT. */
export function jwtExpiry(token: string): number | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** The request body inside a body or a whole envelope. */
export function innerBody(body: unknown): Record<string, unknown> {
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const inner = isEnvelope(o) ? o.Body : o;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
}

/**
 * Why a request that reads by action name would still change the mailbox, or undefined.
 * FindItem / FindConversation with a QueryString make Outlook create an "EWS Search" search folder.
 */
export function sideEffect(action: string, body: unknown): string | undefined {
  const inner = innerBody(body);
  if (/^Find(?:Item|Conversation|People)$/.test(action) && inner.QueryString !== undefined && inner.QueryString !== null && inner.QueryString !== "") {
    return `${action} with a QueryString creates an "EWS Search" search folder in the mailbox; use a Restriction instead`;
  }
  return undefined;
}
