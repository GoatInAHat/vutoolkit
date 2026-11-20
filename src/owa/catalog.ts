/**
 * Search and describe the OWA action catalog. The catalog itself (catalog.generated.ts) is built
 * from Microsoft's published EWS schema; this module adds what the schema cannot say: the actions
 * only Outlook on the web has (seen in its own traffic), the JSON conventions service.svc expects,
 * and request bodies checked against a real mailbox.
 */
import { catalog } from "./catalog.generated.js";
import { ACTION_PATH } from "./client.js";
import { classifyAction, type Access, type Field, type TypeDef } from "./xsd.js";

/** Actions Outlook on the web calls that the EWS schema does not define. */
export const OWA_ONLY: Record<string, { access: Access; summary: string }> = {
  GetCalendarView: { access: "read", summary: "Calendar items between two times, with location, organizer and attendees (what Outlook's calendar shows)." },
  GetFolderChangeDigest: { access: "read", summary: "Recent change summary for folders." },
  GetTimeZone: { access: "read", summary: "The mailbox's time zone." },
  GetTimeZoneOffsets: { access: "read", summary: "UTC offsets of time zones over a range (served from /owa/published/service.svc)." },
  GetUserUnifiedGroups: { access: "read", summary: "Microsoft 365 groups the user belongs to." },
  GetMailboxByIdentity: { access: "read", summary: "Mailbox details for an identity." },
  GetComplianceConfiguration: { access: "read", summary: "Sensitivity labels and compliance settings." },
  GetOwaNonBootUserConfiguration: { access: "read", summary: "Outlook on the web user settings loaded after start-up." },
  GetUnifiedGroupsSettings: { access: "read", summary: "Tenant settings for Microsoft 365 groups." },
  GetPersonalSchedulingPage: { access: "read", summary: "The user's personal booking page settings." },
  UpdateUserConfiguration: { access: "write", summary: "Changes a stored user configuration object (settings)." },
  UpdateUserGroupsSetConfiguration: { access: "write", summary: "Changes the user's group list settings." },
};


export interface ActionSummary {
  action: string;
  access: Access;
  source: "ews-schema" | "ews-docs" | "owa";
  spec?: string;
  summary?: string;
}

const documented = catalog.documented ?? {};

export function accessOf(action: string): Access {
  return catalog.operations[action]?.access ?? documented[action]?.access ?? OWA_ONLY[action]?.access ?? classifyAction(action);
}

export function knownAction(action: string): boolean {
  return action in catalog.operations || action in documented || action in OWA_ONLY;
}

/** Every action, filtered by a case-insensitive query over name and protocol, and by access. */
export function listActions(opts: { query?: string; access?: Access } = {}): ActionSummary[] {
  const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const all: ActionSummary[] = [
    ...Object.entries(catalog.operations).map(([action, op]) => ({ action, access: op.access, source: "ews-schema" as const, spec: op.spec, summary: documented[action]?.summary })),
    ...Object.entries(documented)
      .filter(([action]) => !(action in catalog.operations))
      .map(([action, d]) => ({ action, access: d.access, source: "ews-docs" as const, summary: d.summary })),
    ...Object.entries(OWA_ONLY).map(([action, o]) => ({ action, access: o.access, source: "owa" as const, summary: o.summary })),
  ];
  return all
    .filter((a) => !opts.access || a.access === opts.access)
    .filter((a) => words.every((w) => `${a.action} ${a.spec ?? ""} ${a.summary ?? ""}`.toLowerCase().includes(w)))
    .sort((a, b) => a.action.localeCompare(b.action));
}

/** The JSON `__type` OWA expects for a schema type: "t:ItemResponseShapeType" -> "ItemResponseShape:#Exchange". */
export function jsonTypeName(type: string): string {
  return `${type.replace(/^\w+:/, "").replace(/#element$/, "").replace(/Type$/, "")}:#Exchange`;
}

/** A field as describe shows it. */
export interface FieldView {
  name: string;
  type?: string;
  required?: true;
  many?: true;
  /** Fields with the same choice number are alternatives: send one. */
  choice?: number;
  attribute?: true;
}

export interface TypeView {
  jsonType?: string;
  base?: string;
  fields?: FieldView[];
  enum?: string[];
  value?: string;
}

const MAX_ENUM = 40;

function fieldsOf(type: string, seen = new Set<string>()): Field[] {
  const def = catalog.types[type];
  if (!def || seen.has(type)) return [];
  seen.add(type);
  const inherited = def.base && def.base !== "m:BaseRequestType" ? fieldsOf(def.base, seen) : [];
  return [...inherited, ...(def.fields ?? [])];
}

function viewOf(type: string): TypeView | undefined {
  const def: TypeDef | undefined = catalog.types[type];
  if (!def) return undefined;
  if (def.enum) return { enum: def.enum.length > MAX_ENUM ? [...def.enum.slice(0, MAX_ENUM), `... ${def.enum.length - MAX_ENUM} more`] : def.enum };
  const fields = fieldsOf(type).map((f) => ({
    name: f.name,
    ...(f.type ? { type: f.type } : {}),
    ...(f.min > 0 ? { required: true as const } : {}),
    ...(f.max === -1 || f.max > 1 ? { many: true as const } : {}),
    ...(f.choice !== undefined ? { choice: f.choice } : {}),
    ...(f.attribute ? { attribute: true as const } : {}),
  }));
  return {
    jsonType: jsonTypeName(type),
    ...(def.base && def.base !== "m:BaseRequestType" ? { base: def.base } : {}),
    ...(fields.length ? { fields } : {}),
    ...(def.value ? { value: def.value } : {}),
    ...(!fields.length && def.base ? { value: def.base } : {}),
  };
}

/** How service.svc's JSON differs from the schema's SOAP form. */
export const CONVENTIONS = [
  "Send the request body; owa_call wraps it in OWA's envelope ({__type: '<Action>JsonRequest:#Exchange', Header: {RequestServerVersion, TimeZoneContext}, Body: {__type: '<Action>Request:#Exchange', ...}}). A body that already has Header and Body is sent as given.",
  "Elements become JSON properties with the same names. Attributes (Traversal, Id, ChangeKey, BaseShape ...) are properties too.",
  "Objects carry __type: the schema type name without 'Type' plus ':#Exchange' (t:DistinguishedFolderIdType -> 'DistinguishedFolderId:#Exchange'). describe gives it as jsonType.",
  "Lists are JSON arrays named after the container element (ItemIds: [{__type: 'ItemId:#Exchange', Id}], ParentFolderIds: [...], AdditionalProperties: [{__type: 'PropertyUri:#Exchange', FieldURI: 'Subject'}]).",
  "Paging uses one property, Paging, instead of the schema's choice of views: {__type: 'IndexedPageView:#Exchange', BasePoint: 'Beginning', Offset, MaxEntriesReturned}; for calendars {__type: 'CalendarPageView:#Exchange', StartDate, EndDate, MaxEntriesReturned}.",
  "A Restriction is {__type: 'RestrictionType:#Exchange', Item: <search expression>}; expressions nest the same way (And/Or have Items: [...]).",
  "Avoid QueryString on FindItem: on this service it creates an 'EWS Search' search folder in the mailbox, and repeating it fails with ErrorFolderExists. Use a Restriction.",
  "Item and folder ids are immutable ids (Prefer: IdType=ImmutableId), so they survive moves.",
  "Times come back in the request's TimeZoneContext with an offset, e.g. 2026-11-20T11:15:00-06:00.",
];

const FOLDER = (id: string) => ({ __type: "DistinguishedFolderId:#Exchange", Id: id });
const prop = (uri: string) => ({ __type: "PropertyUri:#Exchange", FieldURI: uri });

/** Request bodies checked against a live Outlook mailbox (all reads). */
export const EXAMPLES: Record<string, unknown> = {
  FindItem: {
    ItemShape: { __type: "ItemResponseShape:#Exchange", BaseShape: "IdOnly", AdditionalProperties: [prop("Subject"), prop("DateTimeReceived"), prop("From"), prop("IsRead")] },
    ParentFolderIds: [FOLDER("inbox")],
    Traversal: "Shallow",
    Paging: { __type: "IndexedPageView:#Exchange", BasePoint: "Beginning", Offset: 0, MaxEntriesReturned: 25 },
    SortOrder: [{ __type: "SortResults:#Exchange", Order: "Descending", Path: prop("DateTimeReceived") }],
    Restriction: {
      __type: "RestrictionType:#Exchange",
      Item: {
        __type: "Contains:#Exchange",
        Item: prop("Subject"),
        Constant: { __type: "ConstantValueType:#Exchange", Value: "invoice" },
        ContainmentMode: "Substring",
        ContainmentComparison: "IgnoreCase",
      },
    },
  },
  GetItem: {
    ItemShape: { __type: "ItemResponseShape:#Exchange", BaseShape: "Default", BodyType: "Text" },
    ItemIds: [{ __type: "ItemId:#Exchange", Id: "<item id from FindItem>" }],
  },
  FindFolder: {
    FolderShape: { __type: "FolderResponseShape:#Exchange", BaseShape: "Default" },
    ParentFolderIds: [FOLDER("msgfolderroot")],
    Traversal: "Deep",
    Paging: { __type: "IndexedPageView:#Exchange", BasePoint: "Beginning", Offset: 0, MaxEntriesReturned: 200 },
  },
  GetCalendarView: {
    CalendarId: { __type: "TargetFolderId:#Exchange", BaseFolderId: FOLDER("calendar") },
    RangeStart: "2026-11-20T00:00:00",
    RangeEnd: "2026-11-27T00:00:00",
  },
};

export interface Described {
  action: string;
  access: Access;
  source: "ews-schema" | "ews-docs" | "owa";
  spec?: string;
  summary?: string;
  /** Microsoft's reference page for the operation. */
  docs?: string;
  path: string;
  request?: string;
  response?: string;
  /** The request body's fields. */
  fields?: FieldView[];
  /** Types the fields use, to the requested depth. */
  types?: Record<string, TypeView>;
  example?: unknown;
  /** The reference's example request, as SOAP XML (convert it to JSON by the conventions). */
  exampleXml?: string;
  recorded?: unknown;
  conventions: string[];
  truncated?: true;
}

/**
 * One action's request schema, with the types it uses expanded breadth-first to `depth` levels
 * (and at most `maxTypes` of them), its JSON conventions and an example body.
 */
export function describeAction(action: string, opts: { depth?: number; maxTypes?: number; recorded?: unknown } = {}): Described | undefined {
  const op = catalog.operations[action];
  const owa = OWA_ONLY[action];
  const doc = documented[action];
  if (!op && !owa && !doc) return undefined;
  const out: Described = {
    action,
    access: accessOf(action),
    source: op ? "ews-schema" : doc ? "ews-docs" : "owa",
    ...(op ? { spec: op.spec, request: op.request, ...(op.response ? { response: op.response } : {}) } : {}),
    ...(doc?.summary || owa?.summary ? { summary: doc?.summary ?? owa!.summary } : {}),
    ...(doc ? { docs: doc.url } : {}),
    path: ACTION_PATH[action] ?? "/owa/service.svc",
    conventions: CONVENTIONS,
  };
  if (op) {
    const top = viewOf(op.request);
    out.fields = top?.fields ?? [];
    const depth = opts.depth ?? 2;
    const maxTypes = opts.maxTypes ?? 40;
    const types: Record<string, TypeView> = {};
    let frontier = out.fields.map((f) => f.type).filter((t): t is string => !!t);
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: string[] = [];
      for (const t of frontier) {
        if (t.startsWith("xs:") || t in types || !catalog.types[t]) continue;
        if (Object.keys(types).length >= maxTypes) {
          out.truncated = true;
          break;
        }
        const view = viewOf(t)!;
        types[t] = view;
        for (const f of view.fields ?? []) if (f.type) next.push(f.type);
      }
      frontier = next;
    }
    out.types = types;
  }
  if (!op && doc?.fields) out.fields = doc.fields.map((name) => ({ name }));
  if (EXAMPLES[action]) out.example = EXAMPLES[action];
  else if (doc?.requestXml) out.exampleXml = doc.requestXml;
  if (opts.recorded) out.recorded = opts.recorded;
  return out;
}

/** One schema type, for following a type describe did not expand. */
export function describeType(type: string): TypeView | undefined {
  const key = /^\w+:/.test(type) ? type : ["t:", "m:"].map((p) => p + type).find((k) => k in catalog.types) ?? type;
  return viewOf(key);
}

export const catalogSource = catalog.source;
