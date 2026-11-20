import { describe, expect, it } from "vitest";
import { buildCatalog, classifyAction, parseXml } from "./xsd.js";

const MESSAGES = `<?xml version="1.0" encoding="utf-8"?>
<xs:schema xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://schemas.microsoft.com/exchange/services/2006/messages">
  <!-- a comment with <tags> -->
  <xs:complexType name="BaseRequestType" abstract="true"/>
  <xs:complexType name="FindThingType">
    <xs:complexContent>
      <xs:extension base="m:BaseRequestType">
        <xs:sequence>
          <xs:element name="Shape" type="t:ShapeType"/>
          <xs:choice minOccurs="0">
            <xs:element name="IndexedView" type="t:ViewType"/>
            <xs:element name="CalendarView" type="t:ViewType"/>
          </xs:choice>
          <xs:element name="Ids" type="t:IdType" maxOccurs="unbounded" minOccurs="0"/>
        </xs:sequence>
        <xs:attribute name="Traversal" type="t:TraversalType" use="required"/>
      </xs:extension>
    </xs:complexContent>
  </xs:complexType>
  <xs:element name="FindThing" type="m:FindThingType"/>
  <xs:element name="FindThingResponse" type="m:FindThingResponseType"/>
  <xs:element name="DeleteThing"><xs:complexType><xs:complexContent><xs:extension base="m:BaseRequestType"/></xs:complexContent></xs:complexType></xs:element>
  <xs:element name="NotARequest" type="t:ShapeType"/>
</xs:schema>`;

const TYPES = `<xs:schema xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://schemas.microsoft.com/exchange/services/2006/types">
  <xs:simpleType name="TraversalType"><xs:restriction base="xs:string"><xs:enumeration value="Shallow"/><xs:enumeration value="Deep"/></xs:restriction></xs:simpleType>
  <xs:complexType name="ShapeType"><xs:sequence><xs:element name="BaseShape" type="xs:string"/></xs:sequence></xs:complexType>
  <xs:complexType name="IdType"><xs:attribute name="Id" type="xs:string" use="required"/></xs:complexType>
</xs:schema>`;

describe("parseXml", () => {
  it("reads nested elements and attributes and skips comments", () => {
    const doc = parseXml(`<?xml version="1.0"?><a x="1 &amp; 2"><!-- <b/> --><b/><c y='z'></c></a>`);
    expect(doc.children[0]).toMatchObject({ tag: "a", attrs: { x: "1 & 2" } });
    expect(doc.children[0].children.map((c) => c.tag)).toEqual(["b", "c"]);
  });
  it("rejects malformed XML", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/malformed/);
    expect(() => parseXml("<a>")).toThrow(/never closed/);
  });
});

describe("buildCatalog", () => {
  const cat = buildCatalog(
    [
      { name: "MS-OXWSTEST-messages.xsd", text: MESSAGES },
      { name: "MS-OXWSTEST-types.xsd", text: TYPES },
    ],
    { repo: "r", commit: "c", path: "p" },
  );
  it("finds request elements derived from BaseRequestType, with their responses", () => {
    expect(Object.keys(cat.operations)).toEqual(["DeleteThing", "FindThing"]);
    expect(cat.operations.FindThing).toEqual({ request: "m:FindThingType", response: "m:FindThingResponseType", access: "read", spec: "MS-OXWSTEST" });
    expect(cat.operations.DeleteThing.access).toBe("write");
    expect(cat.source.files).toBe(2);
  });
  it("records fields with occurrence, choice groups and attributes", () => {
    const fields = cat.types["m:FindThingType"].fields!;
    expect(fields.find((f) => f.name === "Shape")).toMatchObject({ type: "t:ShapeType", min: 1, max: 1 });
    const views = fields.filter((f) => f.choice !== undefined);
    expect(views.map((f) => f.name)).toEqual(["IndexedView", "CalendarView"]);
    expect(new Set(views.map((f) => f.choice)).size).toBe(1);
    expect(views.every((f) => f.min === 0)).toBe(true);
    expect(fields.find((f) => f.name === "Ids")).toMatchObject({ min: 0, max: -1 });
    expect(fields.find((f) => f.name === "Traversal")).toMatchObject({ attribute: true, min: 1, type: "t:TraversalType" });
    expect(cat.types["t:TraversalType"].enum).toEqual(["Shallow", "Deep"]);
  });
});

describe("classifyAction", () => {
  it("treats reads as reads and anything else as a write", () => {
    expect(classifyAction("FindItem")).toBe("read");
    expect(classifyAction("GetItem")).toBe("read");
    expect(classifyAction("SendItem")).toBe("write");
    expect(classifyAction("UpdateInboxRules")).toBe("write");
    expect(classifyAction("SomethingNew")).toBe("write");
  });
  it("keeps the exceptions", () => {
    expect(classifyAction("GetStreamingEvents")).toBe("write");
    expect(classifyAction("GetClientAccessToken")).toBe("write");
    expect(classifyAction("SyncFolderHierarchy")).toBe("read");
  });
});
