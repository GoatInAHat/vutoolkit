/**
 * Outlook mail and calendar tools on Outlook on the web's own service (see client.ts):
 * - owa.actions, owa.describe, owa.call: every action of the generated catalog, called as is.
 * - mail.search, mail.read, mail.folders, calendar.view: the common reads, with flat output and
 *   paging behind a cursor.
 * They need a signed-in browser to supply Outlook's token, so the Railway kit adds them next to
 * its browser.* tools (deploy/railway/server.mjs) rather than to every surface.
 */
import { z } from "zod";
import { accessOf, catalogSource, describeAction, describeType, knownAction, listActions } from "./catalog.js";
import { expectSuccess, owaCall, OwaError, stripTypes, type OwaTransport } from "./client.js";
import type { Operation } from "../toolfactory/types.js";

export interface OwaOptions {
  transport: OwaTransport;
  /** Whether owa.call may run write actions. Defaults to true. */
  writes?: boolean;
  /** Windows time zone name for request times and results. */
  timeZone?: string;
  /** Sanitized request shapes recorded from Outlook's own traffic, by action. */
  recorded?: (action: string) => unknown;
}

const FOLDER = (id: string) => ({ __type: "DistinguishedFolderId:#Exchange", Id: id });
const prop = (uri: string) => ({ __type: "PropertyUri:#Exchange", FieldURI: uri });
const extended = (tag: string) => ({ __type: "ExtendedPropertyUri:#Exchange", PropertyTag: tag, PropertyType: "String" });
const constant = (value: string) => ({ __type: "ConstantValueType:#Exchange", Value: value });

/** Well-known folder names EWS accepts as DistinguishedFolderId. */
const WELL_KNOWN = new Set([
  "inbox", "drafts", "sentitems", "deleteditems", "junkemail", "outbox", "archive", "msgfolderroot", "root", "calendar",
  "contacts", "tasks", "notes", "journal", "conversationhistory", "searchfolders", "recoverableitemsdeletions", "clutter",
]);

/** A folder by well-known name or by id. */
export function folderRef(folder: string): unknown {
  const name = folder.toLowerCase().replace(/[\s_-]/g, "");
  const alias: Record<string, string> = { sent: "sentitems", deleted: "deleteditems", trash: "deleteditems", junk: "junkemail", spam: "junkemail" };
  const known = alias[name] ?? name;
  return WELL_KNOWN.has(known) ? FOLDER(known) : { __type: "FolderId:#Exchange", Id: folder };
}

/** Opaque paging cursor: base64url JSON. */
export const cursor = {
  encode: (state: Record<string, unknown>) => Buffer.from(JSON.stringify(state)).toString("base64url"),
  decode(value: string | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
      const out = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (out && typeof out === "object") return out;
    } catch {
      /* fall through */
    }
    throw new OwaError("OWA_BAD_CURSOR", "That cursor is not one this tool returned; start again without it.");
  },
};

type Obj = Record<string, any>;

const mailbox = (m: Obj | undefined) => {
  const box = m?.Mailbox ?? m;
  if (!box || (box.Name === undefined && box.EmailAddress === undefined)) return undefined;
  return { name: box.Name as string | undefined, email: box.EmailAddress as string | undefined };
};
const mailboxes = (list: unknown) => (Array.isArray(list) ? list.map((m) => mailbox(m)).filter(Boolean) : undefined);
const prune = <T extends Obj>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function flattenMessage(item: Obj) {
  return prune({
    id: item.ItemId?.Id as string,
    conversationId: item.ConversationId?.Id as string | undefined,
    subject: item.Subject as string | undefined,
    from: mailbox(item.From),
    received: item.DateTimeReceived as string | undefined,
    preview: item.Preview as string | undefined,
    isRead: item.IsRead as boolean | undefined,
    hasAttachments: item.HasAttachments as boolean | undefined,
    importance: item.Importance as string | undefined,
    flagged: item.Flag?.FlagStatus ? item.Flag.FlagStatus === "Flagged" : undefined,
    categories: Array.isArray(item.Categories) && item.Categories.length ? (item.Categories as string[]) : undefined,
  });
}

export function flattenFolder(f: Obj) {
  return prune({
    id: f.FolderId?.Id as string,
    name: (f.DisplayName ?? f.FolderDisplayName) as string | undefined,
    parentId: f.ParentFolderId?.Id as string | undefined,
    wellKnown: (f.DistinguishedFolderId as string | undefined) || undefined,
    total: f.TotalCount as number | undefined,
    unread: f.UnreadCount as number | undefined,
    childFolders: f.ChildFolderCount as number | undefined,
    class: f.FolderClass as string | undefined,
  });
}

export function flattenEvent(e: Obj) {
  const location = e.Location?.DisplayName ?? (typeof e.Location === "string" ? e.Location : undefined);
  return prune({
    id: e.ItemId?.Id as string,
    subject: e.Subject as string | undefined,
    start: e.Start as string | undefined,
    end: e.End as string | undefined,
    allDay: e.IsAllDayEvent as boolean | undefined,
    location: location || undefined,
    organizer: mailbox(e.Organizer),
    myResponse: (e.MyResponseType ?? e.ResponseType) as string | undefined,
    showAs: (e.FreeBusyType ?? e.LegacyFreeBusyStatus) as string | undefined,
    cancelled: e.IsCancelled || undefined,
    recurring: e.IsRecurring ?? (e.CalendarItemType && e.CalendarItemType !== "Single" ? true : undefined),
    online: e.IsOnlineMeeting || undefined,
    joinUrl: (e.OnlineMeetingJoinUrl || e.OnlineMeetingSettings?.JoinUrl || undefined) as string | undefined,
    preview: e.Preview as string | undefined,
  });
}

/** Text from the Body of a GetItem result, cut to maxChars. */
export function bodyText(body: Obj | undefined, maxChars: number): { text: string; truncated?: true } {
  const raw = typeof body?.Value === "string" ? (body.Value as string) : "";
  const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text };
}

/** The search restriction for mail.search's filters, or undefined when there are none. */
export function searchRestriction(f: { query?: string; from?: string; unreadOnly?: boolean; since?: string; until?: string }): unknown {
  const contains = (path: unknown, value: string) => ({
    __type: "Contains:#Exchange",
    Item: path,
    Constant: constant(value),
    ContainmentMode: "Substring",
    ContainmentComparison: "IgnoreCase",
  });
  const or = (items: unknown[]) => ({ __type: "Or:#Exchange", Items: items });
  const terms: unknown[] = [];
  if (f.query) terms.push(or([contains(prop("Subject"), f.query), contains(prop("Body"), f.query)]));
  // Sender name, SMTP address (PR_SENDER_SMTP_ADDRESS) and stored address (PR_SENDER_EMAIL_ADDRESS).
  if (f.from) terms.push(or([contains(extended("0x0C1A"), f.from), contains(extended("0x5D01"), f.from), contains(extended("0x0C1F"), f.from)]));
  if (f.unreadOnly) {
    terms.push({
      __type: "IsEqualTo:#Exchange",
      Item: prop("IsRead"),
      FieldURIOrConstant: { __type: "FieldURIOrConstantType:#Exchange", Item: { __type: "Constant:#Exchange", Value: "false" } },
    });
  }
  const at = (op: string, value: string) => ({
    __type: `${op}:#Exchange`,
    Item: prop("DateTimeReceived"),
    FieldURIOrConstant: { __type: "FieldURIOrConstantType:#Exchange", Item: { __type: "Constant:#Exchange", Value: value } },
  });
  if (f.since) terms.push(at("IsGreaterThanOrEqualTo", f.since));
  if (f.until) terms.push(at("IsLessThan", f.until));
  if (!terms.length) return undefined;
  return { __type: "RestrictionType:#Exchange", Item: terms.length === 1 ? terms[0] : { __type: "And:#Exchange", Items: terms } };
}

const isoish = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "a date or date-time, e.g. 2026-11-20 or 2026-11-20T09:00:00");

/** "2026-11-20" -> "2026-11-20T00:00:00"; a date-time is kept as given. */
const startOf = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s);

export function owaOperations(opts: OwaOptions): Operation[] {
  const writes = opts.writes ?? true;
  const call = (action: string, body: unknown) => owaCall(opts.transport, action, body, { timeZone: opts.timeZone });
  const read = async (action: string, body: unknown) => expectSuccess(action, (await call(action, body)).body);
  const annotations = { readOnlyHint: true, openWorldHint: true } as const;

  const actions = {
    name: "owa.actions",
    description:
      "List the Outlook (Exchange) actions owa.call can run: every operation of Microsoft's published EWS schema plus the ones only Outlook on the web uses. Each is marked read or write. Filter by words in the name (e.g. 'item', 'folder', 'calendar', 'rule', 'delegate').",
    input: z.object({
      query: z.string().optional().describe("Words that must all appear in the action name or its protocol, e.g. 'find item'."),
      access: z.enum(["read", "write"]).optional(),
    }),
    output: z.object({
      actions: z.array(z.object({ action: z.string(), access: z.enum(["read", "write"]), source: z.string(), spec: z.string().optional(), summary: z.string().optional() })),
      writesEnabled: z.boolean(),
      schema: z.string(),
    }),
    requires: ["net"],
    annotations,
    handler: ({ query, access }: { query?: string; access?: "read" | "write" }) => ({
      actions: listActions({ query, access }),
      writesEnabled: writes,
      schema: `${catalogSource.repo}@${catalogSource.commit.slice(0, 12)} ${catalogSource.path}`,
    }),
  };

  const describe = {
    name: "owa.describe",
    description:
      "How to call one Outlook action with owa.call: its request fields from Microsoft's EWS schema (choice groups are alternatives), the types they use, the JSON conventions Outlook's service expects, and a checked example body when there is one. Pass `type` to expand one more schema type.",
    input: z.object({
      action: z.string().optional().describe("Action name, e.g. FindItem."),
      type: z.string().optional().describe("A schema type to expand, e.g. t:RestrictionType."),
      depth: z.number().int().min(0).max(4).default(2).describe("How many levels of referenced types to expand."),
    }),
    output: z.object({ description: z.unknown() }),
    requires: ["net"],
    annotations,
    handler: ({ action, type, depth }: { action?: string; type?: string; depth: number }) => {
      if (type) {
        const view = describeType(type);
        if (!view) throw new OwaError("OWA_UNKNOWN_TYPE", `No schema type ${type}.`);
        return { description: { type, ...view } };
      }
      if (!action) throw new OwaError("OWA_BAD_INPUT", "Give an action (or a type).");
      const found = describeAction(action, { depth, recorded: opts.recorded?.(action) });
      if (!found) throw new OwaError("OWA_UNKNOWN_ACTION", `${action} is not in the catalog; owa.actions lists what is. owa.call can still send it.`);
      return { description: found };
    },
  };

  const owaCallOp = {
    name: "owa.call",
    description:
      "Run any Outlook (Exchange) action as the signed-in student, on Outlook on the web's own service: reads such as FindItem, GetItem, FindConversation, ResolveNames, and writes such as CreateItem, SendItem, UpdateItem, MoveItem, DeleteItem or UpdateInboxRules. Give the request body (owa.describe shows its fields and an example); the envelope, time zone and sign-in are handled. Writes change the real mailbox and cannot be undone here. Results are returned without OWA's __type markers unless raw is set.",
    input: z.object({
      action: z.string().describe("Action name, e.g. FindItem."),
      body: z.record(z.string(), z.unknown()).default({}).describe("The request body (or a whole {Header, Body} envelope)."),
      raw: z.boolean().default(false).describe("Return the response exactly as Outlook sent it."),
    }),
    output: z.object({ action: z.string(), access: z.enum(["read", "write"]), status: z.number(), response: z.unknown() }),
    requires: ["net"],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    handler: async ({ action, body, raw }: { action: string; body: Record<string, unknown>; raw: boolean }) => {
      const access = accessOf(action);
      if (access === "write" && !writes) {
        throw new OwaError(
          "OWA_WRITES_DISABLED",
          `${action} ${knownAction(action) ? "changes the mailbox" : "is not a known read"}, and this server has Outlook writes turned off (VUTOOLKIT_OWA_WRITES=0).`,
        );
      }
      const result = await call(action, body);
      return { action, access, status: result.status, response: raw ? result.body : stripTypes(result.body) };
    },
  };

  const folders = {
    name: "mail.folders",
    description: "The student's Outlook mail folders (all levels): id, name, parent, well-known name, total and unread counts.",
    input: z.object({}),
    output: z.object({ folders: z.array(z.record(z.string(), z.unknown())) }),
    requires: ["net"],
    annotations,
    handler: async () => {
      const out: Obj[] = [];
      for (let offset = 0; offset < 5000; ) {
        const [msg] = await read("FindFolder", {
          FolderShape: {
            __type: "FolderResponseShape:#Exchange",
            BaseShape: "Default",
            AdditionalProperties: [prop("DistinguishedFolderId"), prop("FolderClass"), prop("ParentFolderId")],
          },
          ParentFolderIds: [FOLDER("msgfolderroot")],
          Traversal: "Deep",
          Paging: { __type: "IndexedPageView:#Exchange", BasePoint: "Beginning", Offset: offset, MaxEntriesReturned: 250 },
        });
        const root = (msg?.RootFolder ?? {}) as Obj;
        const page = (root.Folders ?? []) as Obj[];
        out.push(...page.map(flattenFolder));
        if (root.IncludesLastItemInRange !== false || !page.length) break;
        offset = typeof root.IndexedPagingOffset === "number" ? root.IndexedPagingOffset : offset + page.length;
      }
      return { folders: out.filter((f) => !f.class || String(f.class).startsWith("IPF.Note") || f.wellKnown) };
    },
  };

  const search = {
    name: "mail.search",
    description:
      "Find messages in one Outlook folder (default inbox), newest first, by words in the subject or body, sender, unread, and received date. Returns id, subject, sender, received time, preview, read and attachment flags; pass nextCursor back to get the next page. Reading never marks mail as read.",
    input: z.object({
      query: z.string().optional().describe("Words to find in the subject or body (one phrase, case-insensitive substring)."),
      from: z.string().optional().describe("Part of the sender's name or address."),
      folder: z.string().default("inbox").describe("A well-known folder (inbox, sentitems, drafts, archive, deleteditems, junkemail) or a folder id from mail.folders."),
      unreadOnly: z.boolean().default(false),
      since: isoish.optional().describe("Received at or after this date or date-time."),
      until: isoish.optional().describe("Received before this date or date-time."),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().optional(),
    }),
    output: z.object({ messages: z.array(z.record(z.string(), z.unknown())), total: z.number().optional(), nextCursor: z.string().optional() }),
    requires: ["net"],
    annotations,
    handler: async (a: { query?: string; from?: string; folder: string; unreadOnly: boolean; since?: string; until?: string; limit: number; cursor?: string }) => {
      const offset = Number(cursor.decode(a.cursor).offset ?? 0);
      const restriction = searchRestriction({ query: a.query, from: a.from, unreadOnly: a.unreadOnly, since: a.since && startOf(a.since), until: a.until && startOf(a.until) });
      const [msg] = await read("FindItem", {
        ItemShape: {
          __type: "ItemResponseShape:#Exchange",
          BaseShape: "IdOnly",
          AdditionalProperties: ["Subject", "From", "DateTimeReceived", "Preview", "IsRead", "HasAttachments", "Importance", "ConversationId", "Flag", "Categories"].map(prop),
        },
        ParentFolderIds: [folderRef(a.folder)],
        Traversal: "Shallow",
        Paging: { __type: "IndexedPageView:#Exchange", BasePoint: "Beginning", Offset: offset, MaxEntriesReturned: a.limit },
        SortOrder: [{ __type: "SortResults:#Exchange", Order: "Descending", Path: prop("DateTimeReceived") }],
        ...(restriction ? { Restriction: restriction } : {}),
      });
      const root = (msg?.RootFolder ?? {}) as Obj;
      const items = (root.Items ?? []) as Obj[];
      const next = typeof root.IndexedPagingOffset === "number" ? root.IndexedPagingOffset : offset + items.length;
      return prune({
        messages: items.map(flattenMessage),
        total: root.TotalItemsInView as number | undefined,
        nextCursor: root.IncludesLastItemInRange === false && items.length ? cursor.encode({ offset: next }) : undefined,
      });
    },
  };

  const readMail = {
    name: "mail.read",
    description:
      "One Outlook message by id (from mail.search): sender, recipients, dates, the body as plain text (cut at maxChars) and attachment names. Does not mark it as read.",
    input: z.object({
      id: z.string(),
      maxChars: z.number().int().min(200).max(200_000).default(20_000),
    }),
    output: z.object({ message: z.record(z.string(), z.unknown()) }),
    requires: ["net"],
    annotations,
    handler: async ({ id, maxChars }: { id: string; maxChars: number }) => {
      const [msg] = await read("GetItem", {
        ItemShape: {
          __type: "ItemResponseShape:#Exchange",
          BaseShape: "IdOnly",
          BodyType: "Text",
          AdditionalProperties: ["Subject", "From", "ToRecipients", "CcRecipients", "DateTimeReceived", "DateTimeSent", "Body", "Attachments", "IsRead", "HasAttachments", "Importance", "ConversationId", "Categories"].map(prop),
        },
        ItemIds: [{ __type: "ItemId:#Exchange", Id: id }],
      });
      const item = ((msg?.Items as Obj[] | undefined) ?? [])[0];
      if (!item) throw new OwaError("ErrorItemNotFound", "Outlook returned no message for that id.");
      const body = bodyText(item.Body, maxChars);
      const attachments = Array.isArray(item.Attachments)
        ? (item.Attachments as Obj[]).map((x) => prune({ id: x.AttachmentId?.Id as string, name: x.Name as string, contentType: x.ContentType as string | undefined, size: x.Size as number | undefined, inline: x.IsInline || undefined }))
        : undefined;
      return {
        message: prune({
          ...flattenMessage(item),
          to: mailboxes(item.ToRecipients),
          cc: mailboxes(item.CcRecipients),
          sent: item.DateTimeSent as string | undefined,
          body: body.text,
          bodyTruncated: body.truncated,
          attachments: attachments?.length ? attachments : undefined,
        }),
      };
    },
  };

  const calendar = {
    name: "calendar.view",
    description:
      "The student's Outlook calendar between two times (default: the next 7 days): each event's subject, start and end with offset, all-day flag, location, organizer, their response, show-as, and online meeting link. Recurring meetings come back as their single occurrences. Pass nextCursor back for more.",
    input: z.object({
      start: isoish.optional().describe("Start of the range, local to the mailbox's time zone. Default: today."),
      end: isoish.optional().describe("End of the range. Default: 7 days after start."),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
    output: z.object({ events: z.array(z.record(z.string(), z.unknown())), nextCursor: z.string().optional() }),
    requires: ["net"],
    annotations,
    handler: async (a: { start?: string; end?: string; limit: number; cursor?: string }) => {
      const state = cursor.decode(a.cursor);
      const today = new Date().toISOString().slice(0, 10);
      const start = (state.start as string | undefined) ?? startOf(a.start ?? today);
      const end = (state.end as string | undefined) ?? startOf(a.end ?? new Date(Date.parse(start.slice(0, 10)) + 7 * 86_400_000).toISOString().slice(0, 10));
      if (Date.parse(end) <= Date.parse(start)) throw new OwaError("OWA_BAD_INPUT", "end must be after start.");
      const result = await call("GetCalendarView", {
        CalendarId: { __type: "TargetFolderId:#Exchange", BaseFolderId: FOLDER("calendar") },
        RangeStart: start,
        RangeEnd: end,
      });
      const body = (result.body as Obj | null)?.Body as Obj | undefined;
      if (body?.ResponseClass === "Error") throw new OwaError(String(body.ResponseCode ?? "OWA_ERROR"), `GetCalendarView failed: ${String(body.MessageText ?? body.ResponseCode)}`);
      const all = ((body?.Items ?? []) as Obj[]).map(flattenEvent).sort((x, y) => Date.parse(x.start ?? "") - Date.parse(y.start ?? ""));
      const offset = Number(state.offset ?? 0);
      const page = all.slice(offset, offset + a.limit);
      return prune({ events: page, nextCursor: offset + a.limit < all.length ? cursor.encode({ start, end, offset: offset + a.limit }) : undefined });
    },
  };

  return [actions, describe, owaCallOp, folders, search, readMail, calendar] as unknown as Operation[];
}
