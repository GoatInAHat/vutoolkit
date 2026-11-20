import { describe, expect, it, vi } from "vitest";
import { cursor, flattenEvent, flattenFolder, flattenMessage, folderRef, owaOperations, searchRestriction } from "./operations.js";
import type { OwaToken } from "./client.js";

const token: OwaToken = { token: "t", origin: "https://outlook.cloud.microsoft", expiresAt: Date.now() + 3_600_000 };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ctx = { config: {}, dataDir: "/tmp" };

function ops(fetch: ReturnType<typeof vi.fn>, writes = true) {
  const list = owaOperations({ transport: { token: async () => token, fetch: fetch as never }, writes });
  return Object.fromEntries(list.map((o) => [o.name, o])) as Record<string, any>;
}
const sent = (fetch: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(String((fetch.mock.calls[i] as any)[1].body));

describe("flattening", () => {
  it("flattens a message", () => {
    expect(
      flattenMessage({
        __type: "Message:#Exchange",
        ItemId: { Id: "A" },
        ConversationId: { Id: "C" },
        Subject: "Hi",
        From: { Mailbox: { Name: "Pat", EmailAddress: "pat@example.edu" } },
        DateTimeReceived: "2026-11-20T09:00:00-06:00",
        IsRead: false,
        Categories: [],
      }),
    ).toEqual({ id: "A", conversationId: "C", subject: "Hi", from: { name: "Pat", email: "pat@example.edu" }, received: "2026-11-20T09:00:00-06:00", isRead: false });
  });
  it("flattens a folder and an event", () => {
    expect(flattenFolder({ FolderId: { Id: "F" }, DisplayName: "Inbox", DistinguishedFolderId: "inbox", TotalCount: 3, UnreadCount: 1 })).toEqual({ id: "F", name: "Inbox", wellKnown: "inbox", total: 3, unread: 1 });
    expect(flattenEvent({ ItemId: { Id: "E" }, Subject: "Lab", Start: "s", End: "e", IsAllDayEvent: false, Location: { DisplayName: "Room 1" }, Organizer: { Mailbox: { Name: "Lee" } } })).toEqual({
      id: "E", subject: "Lab", start: "s", end: "e", allDay: false, location: "Room 1", organizer: { name: "Lee" },
    });
  });
  it("maps folder names", () => {
    expect(folderRef("Sent")).toEqual({ __type: "DistinguishedFolderId:#Exchange", Id: "sentitems" });
    expect(folderRef("AAMkAG=")).toEqual({ __type: "FolderId:#Exchange", Id: "AAMkAG=" });
  });
  it("builds restrictions", () => {
    expect(searchRestriction({})).toBeUndefined();
    const one = searchRestriction({ unreadOnly: true }) as any;
    expect(one.Item.__type).toBe("IsEqualTo:#Exchange");
    const many = searchRestriction({ query: "x", from: "pat", since: "2026-11-01T00:00:00" }) as any;
    expect(many.Item.__type).toBe("And:#Exchange");
    expect(many.Item.Items).toHaveLength(3);
  });
  it("round-trips cursors and rejects foreign ones", () => {
    expect(cursor.decode(cursor.encode({ offset: 25 }))).toEqual({ offset: 25 });
    expect(() => cursor.decode("%%%")).toThrow(/cursor/);
  });
});

describe("tools", () => {
  it("mail.search pages with a cursor and never uses QueryString", async () => {
    const fetch = vi.fn(async () =>
      ok({ Body: { ResponseMessages: { Items: [{ ResponseClass: "Success", RootFolder: { Items: [{ ItemId: { Id: "A" }, Subject: "s" }], IndexedPagingOffset: 1, TotalItemsInView: 2, IncludesLastItemInRange: false } }] } } }),
    );
    const t = ops(fetch);
    const first = await t["mail.search"].handler({ query: "s", folder: "inbox", unreadOnly: false, limit: 1 }, ctx);
    expect(first).toMatchObject({ messages: [{ id: "A", subject: "s" }], total: 2 });
    expect(sent(fetch).Body.QueryString).toBeUndefined();
    expect(sent(fetch).Body.Restriction).toBeTruthy();
    await t["mail.search"].handler({ folder: "inbox", unreadOnly: false, limit: 1, cursor: first.nextCursor }, ctx);
    expect(sent(fetch, 1).Body.Paging.Offset).toBe(1);
  });
  it("mail.read returns plain text bounded by maxChars", async () => {
    const fetch = vi.fn(async () =>
      ok({ Body: { ResponseMessages: { Items: [{ ResponseClass: "Success", Items: [{ ItemId: { Id: "A" }, Subject: "s", Body: { BodyType: "Text", Value: "x".repeat(500) }, ToRecipients: [{ Name: "Me", EmailAddress: "me@x.edu" }] }] }] } } }),
    );
    const { message } = await ops(fetch)["mail.read"].handler({ id: "A", maxChars: 200 }, ctx);
    expect(message.body).toHaveLength(200);
    expect(message.bodyTruncated).toBe(true);
    expect(message.to).toEqual([{ name: "Me", email: "me@x.edu" }]);
    expect(sent(fetch).Body.ItemShape.BodyType).toBe("Text");
  });
  it("calendar.view sorts events and pages them", async () => {
    const fetch = vi.fn(async () => ok({ Body: { ResponseClass: "Success", Items: [{ ItemId: { Id: "2" }, Start: "2026-11-21T09:00:00-06:00" }, { ItemId: { Id: "1" }, Start: "2026-11-20T09:00:00-06:00" }] } }));
    const t = ops(fetch);
    const page = await t["calendar.view"].handler({ start: "2026-11-20", end: "2026-11-27", limit: 1 }, ctx);
    expect(page.events.map((e: any) => e.id)).toEqual(["1"]);
    expect(sent(fetch).Body.RangeStart).toBe("2026-11-20T00:00:00");
    const next = await t["calendar.view"].handler({ limit: 1, cursor: page.nextCursor }, ctx);
    expect(next.events.map((e: any) => e.id)).toEqual(["2"]);
    expect(next.nextCursor).toBeUndefined();
  });
  it("owa.call runs reads, and writes only when enabled", async () => {
    const fetch = vi.fn(async () => ok({ Body: { __type: "x", ResponseMessages: { Items: [] } } }));
    expect(await ops(fetch)["owa.call"].handler({ action: "FindItem", body: {}, raw: false }, ctx)).toMatchObject({ access: "read", status: 200, response: { Body: { ResponseMessages: { Items: [] } } } });
    await expect(ops(fetch, false)["owa.call"].handler({ action: "SendItem", body: {}, raw: false }, ctx)).rejects.toMatchObject({ code: "OWA_WRITES_DISABLED" });
    await expect(ops(fetch, false)["owa.call"].handler({ action: "BrandNewThing", body: {}, raw: false }, ctx)).rejects.toMatchObject({ code: "OWA_WRITES_DISABLED" });
    await expect(ops(fetch, false)["owa.call"].handler({ action: "FindItem", body: { QueryString: "x" }, raw: false }, ctx)).rejects.toMatchObject({ code: "OWA_WRITES_DISABLED" });
    await ops(fetch, true)["owa.call"].handler({ action: "SendItem", body: {}, raw: false }, ctx);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("owa.actions and owa.describe answer from the catalog", async () => {
    const t = ops(vi.fn());
    expect((await t["owa.actions"].handler({ query: "inbox rules" }, ctx)).actions.map((a: any) => a.action)).toEqual(expect.arrayContaining(["GetInboxRules", "UpdateInboxRules"]));
    expect((await t["owa.describe"].handler({ action: "GetItem", depth: 1 }, ctx)).description.example).toBeTruthy();
  });
});
