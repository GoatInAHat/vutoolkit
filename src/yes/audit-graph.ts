import type { JsonObject, OfficialAuditSnapshot } from "./planning-client.js";
const list = (v: unknown): JsonObject[] => Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
const record = (v: unknown): JsonObject => v && typeof v === "object" ? v as JsonObject : {};
const optionalNumber = (v: unknown): number | undefined => v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
export interface AuditNode { id: string; kind: "audit" | "group" | "requirement" | "line" | "course"; label: string; description?: string; state: string; reportSequence?: number; entrySequence?: number; coursesNeeded?: number; unitsNeeded?: number; hasPossibleCourses?: boolean; metadata?: JsonObject }
/** Official requirement semantics/status are copied, never replaced with guessed prerequisite rules. */
export function officialAuditGraph(snapshot: OfficialAuditSnapshot) {
  const nodes = new Map<string, AuditNode>();
  const edges: { source: string; target: string; relation: string }[] = [];
  for (const audit of snapshot.audits) {
    const report = Number(audit.reportSequence), root = `audit:${report}`;
    nodes.set(root, { id: root, kind: "audit", label: `${String(record(audit.career).longDescription ?? "Degree")} audit`, state: "official", reportSequence: report, metadata: { asOfDate: audit.asOfDate, reportDate: audit.reportDate } });
    const walk = (row: JsonObject, parent: string, kind: "group" | "requirement" | "line") => {
      const id = `${parent}:${kind}:${row.entrySequence}`;
      nodes.set(id, { id, kind, label: String(row.name || row.description || kind), description: String(row.description ?? ""), state: row.waived ? "waived" : row.satisfied ? "satisfied" : row.notSatisfied ? "needed" : String(row.status ?? "unknown"), reportSequence: report, entrySequence: optionalNumber(row.entrySequence), coursesNeeded: optionalNumber(row.coursesNeeded), unitsNeeded: optionalNumber(row.unitsNeeded), hasPossibleCourses: Boolean(row.hasPossibleCourses), metadata: { coursesRequired: row.coursesRequired, unitsRequired: row.unitsRequired, gpaRequired: row.gpaRequired, conditionalRequirement: row.conditionalRequirement, lineType: row.lineType, status: row.status } });
      edges.push({ source: id, target: parent, relation: "official-requirement" });
      for (const c of list(row.coursesUsedToSatisfy)) {
        const code = `${c.subject} ${c.catalogNumber}`, courseId = `course:${c.courseId}`;
        if (!nodes.has(courseId)) nodes.set(courseId, { id: courseId, kind: "course", label: code, description: String(c.longTitle ?? ""), state: c.whatIf ? "what-if" : /^(?:[ABCD][+-]?|P|S|CR)$/.test(String(c.grade ?? "").trim()) && Number(c.unitsEarned) > 0 ? "completed" : String(c.grade ?? "").trim() ? "recorded" : "in-progress", metadata: { title: c.longTitle, courseId: c.courseId, offerNumber: c.courseOfferNumber, credits: c.unitsTaken, term: c.termTaken } });
        edges.push({ source: courseId, target: id, relation: "used-by-official-audit" });
      }
      for (const child of list(row.requirements)) walk(child, id, "requirement");
      for (const child of list(row.requirementLines)) walk(child, id, "line");
    };
    for (const group of list(audit.requirementGroups)) walk(group, root, "group");
  }
  for (const entry of snapshot.plannerCourses) {
    const c = record(entry.course), key = record(c.courseKey), subject = record(c.subjectArea), id = `course:${key.id}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind: "course", label: `${subject.code} ${c.catalogNumber}`, description: String(c.title ?? ""), state: "planned", metadata: { courseId: key.id, offerNumber: key.offerNumber, title: c.title, credits: record(c.unitRange).min, typicallyOffered: c.typicallyOfferedTerm, termTag: entry.termTagLabel } });
  }
  return { nodes: [...nodes.values()], edges, source: snapshot.source, fetchedAt: snapshot.fetchedAt, alternativesLoaded: false, note: "Statuses and constraints are Vanderbilt's official audit. Expand a requirement to retrieve its official course alternatives; prerequisites are separate catalog metadata. Planned courses remain visible even when not required." };
}
