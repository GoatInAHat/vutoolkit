// Playwright MCP `browser.initPage` hook: watches the signed-in browser's own requests to Outlook on
// the web's service (outlook.cloud.microsoft/owa/service.svc) and keeps, in this process only,
//  - the newest bearer token Outlook's page sent, with its origin, mailbox routing hint and expiry,
//    which src/owa/client.ts reuses for vutoolkit's mail and calendar tools; and
//  - the shape of each action's request body (keys, OWA __type markers and a few structural
//    values, never message content), which owa.describe shows as a recorded example.
// Nothing here changes a request. The state is shared with browser.mjs through a global symbol
// because Playwright MCP loads this file with require(), outside browser.mjs's module graph.
const KEY = Symbol.for("vutoolkit.owa");
const state = (globalThis[KEY] ??= { context: undefined, token: undefined, recorded: new Map(), listeners: new Set() });

const SERVICE = /^https:\/\/(outlook\.(?:cloud\.microsoft|office\.com|office365\.com))\/owa\/(?:published\/)?service\.svc(?:\?|$)/;
/** Values kept verbatim in a recorded shape: enum-like settings, never free text. */
const KEEP = new Set([
  "__type", "BaseShape", "BodyType", "Traversal", "BasePoint", "Order", "FieldURI", "PropertyTag", "PropertyType", "PropertySetId",
  "DistinguishedPropertySetId", "PropertyName", "ContainmentMode", "ContainmentComparison", "RequestServerVersion", "ShapeName",
  "FilterType", "ViewFilter", "FocusedViewFilter", "SortOrder", "IdType", "ConversationShapeName", "SearchScope",
]);
const MAX_RECORDED = 200;

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** The request's structure with every free value replaced by its JSON type. */
function shape(value, key, depth = 0) {
  if (depth > 12) return "…";
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => shape(v, key, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shape(v, k, depth + 1);
    return out;
  }
  if (typeof value === "string" && KEEP.has(key) && value.length <= 80) return value;
  // A distinguished folder name (inbox, calendar...) is structure, not content.
  if (key === "Id" && typeof value === "string" && /^[a-z]{3,30}$/.test(value)) return value;
  if (typeof value === "boolean" || typeof value === "number") return typeof value;
  return value === null ? null : typeof value;
}

function requestBody(request, headers) {
  try {
    const raw = request.postData() || (headers["x-owa-urlpostdata"] ? decodeURIComponent(headers["x-owa-urlpostdata"]) : "");
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

async function onRequest(request) {
  const match = SERVICE.exec(request.url());
  if (!match) return;
  let headers;
  try {
    headers = await request.allHeaders();
  } catch {
    return;
  }
  const auth = headers.authorization ?? "";
  if (/^Bearer\s+\S+\.\S+\.\S+$/i.test(auth)) {
    const token = auth.replace(/^Bearer\s+/i, "");
    const expiresAt = jwtExpiry(token) ?? Date.now() + 30 * 60_000;
    if (!state.token || state.token.token !== token) {
      state.token = { token, origin: `https://${match[1]}`, anchorMailbox: headers["x-anchormailbox"], expiresAt, capturedAt: Date.now() };
      for (const listener of state.listeners) listener();
    }
  }
  const action = headers.action ?? new URL(request.url()).searchParams.get("action");
  if (action && /^[A-Za-z][A-Za-z0-9]{1,80}$/.test(action) && !state.recorded.has(action) && state.recorded.size < MAX_RECORDED) {
    const body = requestBody(request, headers);
    if (body && typeof body === "object") state.recorded.set(action, shape(body.Body ?? body, "Body"));
  }
}

exports.default = async ({ page }) => {
  const context = page.context();
  if (state.context === context) return;
  state.context = context;
  context.on("request", (request) => void onRequest(request).catch(() => {}));
  context.on("close", () => {
    if (state.context === context) state.context = undefined;
  });
};
