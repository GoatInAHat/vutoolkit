/**
 * Builds the OWA action catalog from Microsoft's published Exchange Web Services schema (the
 * MS-OXWS* XSD files). Outlook on the web's service.svc takes the same operations and types as EWS,
 * as JSON instead of SOAP, so the schema is the authoritative list of what can be called and what
 * each request may carry. scripts/owa-catalog.mjs runs this over the schema files and writes the
 * result to catalog.generated.ts; nothing here runs at request time.
 *
 * The XSD files are plain, well-formed XML, so a small tag reader is enough and the toolkit takes no
 * XML dependency.
 */

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Element tree of an XML document (text content is dropped: the schema carries none we need). */
export function parseXml(text: string): XmlNode {
  const root: XmlNode = { tag: "#document", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!(?:[^>])*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1]) {
      const closing = m[1];
      const top = stack.pop();
      if (!top || top.tag !== closing) throw new Error(`malformed XML: </${closing}> closes <${top?.tag}>`);
      continue;
    }
    if (!m[2]) continue;
    const attrs: Record<string, string> = {};
    const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[3] ?? ""))) attrs[a[1]] = decode(a[2] ?? a[3] ?? "");
    const node: XmlNode = { tag: m[2], attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`malformed XML: <${stack[stack.length - 1].tag}> is never closed`);
  return root;
}

/** One element or attribute a type carries. */
export interface Field {
  name: string;
  /** "t:Foo", "m:Bar" or "xs:string"; absent for an anonymous inline type. */
  type?: string;
  /** Minimum occurrences (0 = optional). */
  min: number;
  /** Maximum occurrences; -1 = unbounded. */
  max: number;
  /** Fields that share a choice number are alternatives: send one of them. */
  choice?: number;
  attribute?: true;
}

export interface TypeDef {
  /** The type this one extends or restricts. */
  base?: string;
  fields?: Field[];
  /** Allowed values of a string enumeration. */
  enum?: string[];
  /** Simple content (a value with attributes) of this XSD type. */
  value?: string;
  /** The schema file (protocol) that defines it. */
  spec: string;
}

export type Access = "read" | "write";

export interface OperationDef {
  request: string;
  response?: string;
  access: Access;
  spec: string;
}

/** An operation as Microsoft's EWS reference documents it. */
export interface DocumentedOperation {
  /** The reference page. */
  url: string;
  summary?: string;
  /** The request's top-level elements, from the reference's request example. */
  fields?: string[];
  /** The reference's example request (the SOAP body's operation element), as XML. */
  requestXml?: string;
}

export interface Catalog {
  source: { repo: string; commit: string; path: string; files: number; docs?: { repo: string; commit: string; path: string; pages: number } };
  operations: Record<string, OperationDef>;
  types: Record<string, TypeDef>;
  /** Every operation of Microsoft's EWS reference, including those the schema files leave out. */
  documented?: Record<string, DocumentedOperation & { access: Access }>;
}

const NS: Record<string, "m" | "t"> = {
  "http://schemas.microsoft.com/exchange/services/2006/messages": "m",
  "http://schemas.microsoft.com/exchange/services/2006/types": "t",
};

/**
 * Operations that only read. Everything else, including any action the schema does not know, is a
 * write: an unknown verb is never assumed harmless.
 */
const READ_VERBS = /^(?:Get|Find|Resolve|Expand|ConvertId|Sync|Search|Query|Export|Is|Check|Preview)/;
const WRITE_ANYWAY = /^(?:GetStreamingEvents|GetEvents|GetClientAccessToken)$/;
/** Reads that look like writes by name. */
const READ_ANYWAY = /^(?:PerformInstantSearch|SyncFolderHierarchy)$/;

export function classifyAction(name: string): Access {
  if (READ_ANYWAY.test(name)) return "read";
  // Event streams and client tokens hand out server state or credentials; treat them as writes.
  if (WRITE_ANYWAY.test(name)) return "write";
  return READ_VERBS.test(name) ? "read" : "write";
}

const occurs = (v: string | undefined, dflt: number) => (v === undefined ? dflt : v === "unbounded" ? -1 : Number(v));

/** Normalizes a QName from one schema file to the catalog's "m:" / "t:" / "xs:" prefixes. */
function qualifier(schema: XmlNode, targetNs: string) {
  const prefixes: Record<string, string> = {};
  for (const [k, v] of Object.entries(schema.attrs)) {
    if (k.startsWith("xmlns:")) prefixes[k.slice(6)] = v;
  }
  const own = NS[targetNs] ?? "t";
  return {
    own,
    q(name: string | undefined): string | undefined {
      if (!name) return undefined;
      const [p, local] = name.includes(":") ? name.split(":", 2) : ["", name];
      if (!p) return `${own}:${local}`;
      const ns = prefixes[p];
      if (ns === "http://www.w3.org/2001/XMLSchema") return `xs:${local}`;
      return `${NS[ns ?? ""] ?? p}:${local}`;
    },
  };
}

const local = (tag: string) => tag.replace(/^[\w.-]+:/, "");

/** Parse the given schema files into the catalog. */
export function buildCatalog(files: Array<{ name: string; text: string }>, source: { repo: string; commit: string; path: string }): Catalog {
  const types: Record<string, TypeDef> = {};
  const elements: Record<string, { type?: string; spec: string }> = {};
  const groups: Record<string, XmlNode> = {};
  const pending: Array<{ key: string; node: XmlNode; q: ReturnType<typeof qualifier>; spec: string }> = [];

  for (const file of files) {
    const doc = parseXml(file.text);
    const schema = doc.children.find((c) => local(c.tag) === "schema");
    if (!schema) continue;
    const q = qualifier(schema, schema.attrs.targetNamespace ?? "");
    const spec = file.name.replace(/-(?:types|messages?)\.xsd$/i, "");
    for (const node of schema.children) {
      const kind = local(node.tag);
      const name = node.attrs.name;
      if (!name) continue;
      const key = `${q.own}:${name}`;
      if (kind === "complexType" || kind === "simpleType") pending.push({ key, node, q, spec });
      else if (kind === "element") {
        if (!elements[key]) elements[key] = { type: q.q(node.attrs.type), spec };
        // An element with an anonymous type gets a type of its own name.
        const inline = node.children.find((c) => local(c.tag) === "complexType" || local(c.tag) === "simpleType");
        if (inline && !node.attrs.type) {
          pending.push({ key: `${key}#element`, node: inline, q, spec });
          elements[key] = { type: `${key}#element`, spec };
        }
      } else if (kind === "group") groups[key] = node;
    }
  }

  let choiceSeq = 0;
  const readParticles = (node: XmlNode, q: ReturnType<typeof qualifier>, out: Field[], choice?: number, minScale = 1) => {
    for (const child of node.children) {
      const kind = local(child.tag);
      if (kind === "element") {
        const ref = q.q(child.attrs.ref);
        const name = child.attrs.name ?? (ref ? ref.replace(/^\w+:/, "") : "?");
        const type = child.attrs.type ? q.q(child.attrs.type) : ref ? elements[ref]?.type ?? ref : undefined;
        out.push({ name, type, min: occurs(child.attrs.minOccurs, 1) * minScale, max: occurs(child.attrs.maxOccurs, 1), ...(choice !== undefined ? { choice } : {}) });
      } else if (kind === "sequence" || kind === "all") {
        readParticles(child, q, out, choice, occurs(child.attrs.minOccurs, 1) === 0 ? 0 : minScale);
      } else if (kind === "choice") {
        const id = ++choiceSeq;
        // Each alternative is optional on its own; the choice as a whole may also be optional.
        readParticles(child, q, out, id, 0);
      } else if (kind === "group") {
        const g = groups[q.q(child.attrs.ref) ?? ""];
        if (g) readParticles(g, q, out, choice, minScale);
      } else if (kind === "attribute") {
        const name = child.attrs.name ?? child.attrs.ref?.replace(/^\w+:/, "") ?? "?";
        out.push({ name, type: q.q(child.attrs.type) ?? "xs:string", min: child.attrs.use === "required" ? 1 : 0, max: 1, attribute: true });
      } else if (kind === "any") {
        out.push({ name: "*", type: "xs:anyType", min: 0, max: occurs(child.attrs.maxOccurs, 1) });
      }
    }
  };

  const readType = (node: XmlNode, q: ReturnType<typeof qualifier>, spec: string): TypeDef => {
    const def: TypeDef = { spec };
    if (local(node.tag) === "simpleType") {
      const restriction = node.children.find((c) => local(c.tag) === "restriction");
      if (restriction) {
        const values = restriction.children.filter((c) => local(c.tag) === "enumeration").map((c) => c.attrs.value);
        if (values.length) def.enum = values;
        else def.base = q.q(restriction.attrs.base) ?? "xs:string";
      } else def.base = "xs:string";
      return def;
    }
    const fields: Field[] = [];
    for (const child of node.children) {
      const kind = local(child.tag);
      if (kind === "complexContent" || kind === "simpleContent") {
        const derivation = child.children.find((c) => ["extension", "restriction"].includes(local(c.tag)));
        if (!derivation) continue;
        const base = q.q(derivation.attrs.base);
        if (kind === "simpleContent") def.value = base;
        else def.base = base;
        readParticles(derivation, q, fields);
      } else readParticles({ ...child, children: [child] } as XmlNode, q, fields);
    }
    if (fields.length) def.fields = fields;
    return def;
  };

  for (const { key, node, q, spec } of pending) {
    const def = readType(node, q, spec);
    const have = types[key];
    // The protocol schemas overlap; keep the fullest definition of a shared type.
    if (!have || (def.fields?.length ?? def.enum?.length ?? 0) > (have.fields?.length ?? have.enum?.length ?? 0)) types[key] = def;
  }

  const derivesFromRequest = (type: string | undefined, seen = new Set<string>()): boolean => {
    if (!type || seen.has(type)) return false;
    if (type === "m:BaseRequestType") return true;
    seen.add(type);
    return derivesFromRequest(types[type]?.base, seen);
  };

  const operations: Record<string, OperationDef> = {};
  for (const [key, el] of Object.entries(elements)) {
    if (!key.startsWith("m:") || key.endsWith("Response") || !derivesFromRequest(el.type)) continue;
    const name = key.slice(2);
    const response = elements[`m:${name}Response`]?.type;
    operations[name] = { request: el.type!, ...(response ? { response } : {}), access: classifyAction(name), spec: el.spec };
  }

  const sorted = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { source: { ...source, files: files.length }, operations: sorted(operations), types: sorted(types) };
}

const MAX_EXAMPLE = 4000;

/**
 * The operations Microsoft's EWS reference lists ("EWS operations in Exchange"), each with its page's
 * summary and example request. `pages` maps a page file name to its Markdown; `base` is the
 * published URL the file names resolve against.
 */
export function documentedOperations(index: string, pages: Record<string, string>, base: string): Record<string, DocumentedOperation & { access: Access }> {
  const out: Record<string, DocumentedOperation & { access: Access }> = {};
  for (const m of index.matchAll(/\[([A-Za-z]+) operation\]\(([a-z0-9-]+)\.md\)/g)) {
    const [, name, file] = m;
    if (out[name]) continue;
    const entry: DocumentedOperation & { access: Access } = { url: `${base}/${file}`, access: classifyAction(name) };
    const page = pages[`${file}.md`];
    if (page) {
      const body = page.replace(/^---[\s\S]*?\n---\n/, "");
      // The first plain paragraph after the title that says what the operation does.
      const summary = body
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .find((p) => p && !p.startsWith("#") && !/^Find information about/i.test(p) && !p.startsWith("<") && !p.startsWith("|") && !p.startsWith("```"));
      if (summary) entry.summary = summary.replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").slice(0, 400);
      const xml = /```xml\s*\n([\s\S]*?)```/i.exec(body)?.[1];
      const start = xml ? xml.search(/<soap:Body[^>]*>/i) : -1;
      if (xml && start >= 0) {
        const inner = xml.slice(xml.indexOf(">", start) + 1, xml.search(/<\/soap:Body\s*>/i) >>> 0).trim();
        try {
          const op = parseXml(inner).children[0];
          if (op) {
            entry.fields = [...new Set(op.children.map((c) => local(c.tag)))];
            entry.requestXml = inner.length > MAX_EXAMPLE ? `${inner.slice(0, MAX_EXAMPLE)}\n<!-- cut -->` : inner;
          }
        } catch {
          /* an example that is not well-formed: keep the summary and link */
        }
      }
    }
    out[name] = entry;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
