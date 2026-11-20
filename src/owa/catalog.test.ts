import { describe, expect, it } from "vitest";
import { accessOf, describeAction, describeType, jsonTypeName, listActions } from "./catalog.js";

describe("the generated catalog", () => {
  it("covers the EWS operations and marks them", () => {
    const all = listActions();
    expect(all.length).toBeGreaterThan(70);
    expect(accessOf("FindItem")).toBe("read");
    expect(accessOf("CreateItem")).toBe("write");
    expect(accessOf("DeleteItem")).toBe("write");
    expect(accessOf("UpdateInboxRules")).toBe("write");
    expect(accessOf("GetCalendarView")).toBe("read");
    expect(accessOf("NoSuchActionYet")).toBe("write");
  });
  it("filters by words and access", () => {
    const found = listActions({ query: "find", access: "read" }).map((a) => a.action);
    expect(found).toContain("FindItem");
    expect(found).toContain("FindFolder");
    expect(listActions({ query: "send", access: "read" }).map((a) => a.action)).toEqual([]);
  });
  it("describes FindItem with its fields, types and a checked example", () => {
    const d = describeAction("FindItem")!;
    expect(d.access).toBe("read");
    expect(d.fields!.map((f) => f.name)).toEqual(expect.arrayContaining(["ItemShape", "Restriction", "ParentFolderIds", "Traversal"]));
    expect(d.types!["t:ItemResponseShapeType"]?.jsonType).toBe("ItemResponseShape:#Exchange");
    expect(d.example).toBeTruthy();
    expect(d.conventions.join(" ")).toMatch(/QueryString/);
  });
  it("describes an Outlook-only action and a single type", () => {
    expect(describeAction("GetCalendarView")).toMatchObject({ source: "owa", access: "read" });
    expect(describeType("ItemQueryTraversalType")?.enum).toContain("Shallow");
    expect(describeAction("Nope")).toBeUndefined();
  });
  it("names JSON types the way Outlook expects", () => {
    expect(jsonTypeName("t:DistinguishedFolderIdType")).toBe("DistinguishedFolderId:#Exchange");
    expect(jsonTypeName("m:FindItemType")).toBe("FindItem:#Exchange");
  });
});

describe("the reference's operations", () => {
  it("adds what the schema files leave out", () => {
    for (const action of ["GetUserAvailability", "GetInboxRules", "GetUserOofSettings", "GetMailTips"]) expect(accessOf(action)).toBe("read");
    for (const action of ["UpdateInboxRules", "SetUserOofSettings", "ArchiveItem"]) expect(accessOf(action)).toBe("write");
    const d = describeAction("GetUserAvailability")!;
    expect(d).toMatchObject({ source: "ews-docs", docs: expect.stringContaining("learn.microsoft.com") });
    expect(d.fields!.map((f) => f.name)).toContain("MailboxDataArray");
    expect(d.exampleXml).toMatch(/FreeBusyViewOptions/);
    expect(listActions({ query: "inbox rules" }).map((a) => a.action)).toEqual(["GetInboxRules", "UpdateInboxRules"]);
  });
});
