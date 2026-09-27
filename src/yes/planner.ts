/** Deterministic prerequisite graphs; ambiguous catalog prose is explicitly unresolved. */
export type RequirementExpression = { kind: "course"; course: string } | { kind: "all" | "any"; items: RequirementExpression[] } | { kind: "unknown"; text: string };
export interface PlannerCourse { course: string; title?: string; credits?: number; prerequisites?: RequirementExpression; description?: string; typicallyOffered?: string; instructors?: string[]; rating?: { average: number; count: number; url: string }; sourceUrl?: string }
export interface PlannerRequest { courses: PlannerCourse[]; completed?: string[]; planned?: string[]; goals?: string[]; preferences?: Record<string, number>; maxAlternatives?: number }
const normalize = (v: string) => v.trim().toUpperCase().replace(/\s*[- ]\s*(?=\d)/, " ").replace(/\s+/g, " ");
/** Full course codes, parentheses, AND/OR, and unambiguous Oxford lists only. */
export function parsePrerequisites(text: string): RequirementExpression {
  let value = text.replace(/^\s*(?:prerequisites?|prereq)\s*:\s*/i, "").replace(/[.\s]+$/, "").trim();
  if (!value || /^(?:none|no prerequisites)$/i.test(value)) return { kind: "all", items: [] };
  if (!/[()]/.test(value) && value.includes(",") && !/\band\b/i.test(value) && /\bor\b/i.test(value)) value = value.replace(/,\s*(?:or\s+)?/gi, " or ");
  else if (!/[()]/.test(value) && value.includes(",") && !/\bor\b/i.test(value) && /\band\b/i.test(value)) value = value.replace(/,\s*(?:and\s+)?/gi, " and ");
  if (!/[()]/.test(value) && /\band\b/i.test(value) && /\bor\b/i.test(value)) return { kind: "unknown", text };
  const tokenPattern = /[A-Z][A-Z&]{1,7}[ -]+\d{3,4}[A-Z]?|\bAND\b|\bOR\b|[()]/gi;
  const tokens = value.match(tokenPattern) ?? [];
  if (value.replace(tokenPattern, "").trim()) return { kind: "unknown", text };
  let pos = 0;
  const atom = (): RequirementExpression => {
    const token = tokens[pos++];
    if (token === "(") { const result = any(); if (tokens[pos++] !== ")") throw new Error("unclosed"); return result; }
    const course = normalize(token ?? "");
    if (!/^[A-Z][A-Z&]{1,7}\s+\d{3,4}[A-Z]?$/.test(course)) throw new Error("not a course");
    return { kind: "course", course };
  };
  const all = (): RequirementExpression => { const items = [atom()]; while (tokens[pos]?.toLowerCase() === "and") { pos++; items.push(atom()); } return items.length === 1 ? items[0]! : { kind: "all", items }; };
  const any = (): RequirementExpression => { const items = [all()]; while (tokens[pos]?.toLowerCase() === "or") { pos++; items.push(all()); } return items.length === 1 ? items[0]! : { kind: "any", items }; };
  try { const result = any(); return pos === tokens.length ? result : { kind: "unknown", text }; } catch { return { kind: "unknown", text }; }
}
export interface PlannerNode { id: string; kind: "course" | "all" | "any" | "unknown"; label: string; state: "completed" | "planned" | "available" | "blocked" | "unknown"; course?: PlannerCourse; minimumAdditionalCredits?: number; rank?: number }
export function buildDegreeGraph(request: PlannerRequest) {
  const courses = new Map(request.courses.map((c) => [normalize(c.course), { ...c, course: normalize(c.course) }]));
  if (courses.size !== request.courses.length) throw new Error("Planner course codes must be unique");
  const completed = new Set((request.completed ?? []).map(normalize)), planned = new Set((request.planned ?? []).map(normalize));
  const preferences = Object.fromEntries(Object.entries(request.preferences ?? {}).map(([course, weight]) => [normalize(course), weight]));
  const limit = request.maxAlternatives ?? 10000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("maxAlternatives must be a positive integer");
  const nodes = new Map<string, PlannerNode>();
  const edges: { source: string; target: string; relation: "prerequisite" | "all" | "any"; weight: number }[] = [];
  const warnings = new Set<string>(); let truncated = false;
  const addCourse = (name: string) => { const id = normalize(name); if (!nodes.has(id)) nodes.set(id, { id, kind: "course", label: id, course: courses.get(id), state: completed.has(id) ? "completed" : planned.has(id) ? "planned" : "unknown" }); return id; };
  const addExpression = (expression: RequirementExpression, target: string, path: string): void => {
    if (expression.kind === "course") { const id = addCourse(expression.course); edges.push({ source: id, target, relation: "prerequisite", weight: courses.get(id)?.credits ?? 0 }); return; }
    const id = `${path}:${expression.kind}`;
    nodes.set(id, { id, kind: expression.kind, label: expression.kind === "unknown" ? expression.text : expression.kind.toUpperCase(), state: "unknown" });
    edges.push({ source: id, target, relation: expression.kind === "any" ? "any" : "all", weight: 0 });
    if (expression.kind !== "unknown") expression.items.forEach((item, i) => addExpression(item, id, `${path}.${i}`));
  };
  for (const [id, course] of courses) { addCourse(id); if (course.prerequisites) addExpression(course.prerequisites, id, id); }
  for (const id of [...(request.goals ?? []), ...planned, ...completed]) addCourse(id);
  type Alternative = { courses: string[]; unresolved: string[] };
  const unique = (rows: Alternative[]): Alternative[] => {
    const found = new Map<string, Alternative>();
    for (const row of rows) { const normalized = { courses: [...new Set(row.courses)].sort(), unresolved: [...new Set(row.unresolved)].sort() }; found.set(JSON.stringify(normalized), normalized); if (found.size > limit) { truncated = true; break; } }
    return [...found.values()].slice(0, limit);
  };
  const combine = (a: Alternative[], b: Alternative[]) => { const rows: Alternative[] = []; outer: for (const x of a) for (const y of b) { rows.push({ courses: [...x.courses, ...y.courses], unresolved: [...x.unresolved, ...y.unresolved] }); if (rows.length > limit) { truncated = true; break outer; } } return unique(rows); };
  const expandCourse = (name: string, path: Set<string>): Alternative[] => {
    const id = normalize(name); if (completed.has(id)) return [{ courses: [], unresolved: [] }];
    if (path.has(id)) { warnings.add(`Prerequisite cycle at ${id}`); return [{ courses: [id], unresolved: [`cycle:${id}`] }]; }
    const course = courses.get(id), next = new Set([...path, id]);
    const prerequisites = course?.prerequisites ? expand(course.prerequisites, next) : [{ courses: [], unresolved: [`Unverified prerequisites: ${id}`] }];
    return prerequisites.map((p) => ({ courses: [...p.courses, id], unresolved: p.unresolved }));
  };
  const expand = (expression: RequirementExpression, path: Set<string>): Alternative[] => {
    if (expression.kind === "course") return expandCourse(expression.course, path);
    if (expression.kind === "unknown") return [{ courses: [], unresolved: [expression.text] }];
    if (expression.kind === "any") return unique(expression.items.flatMap((item) => expand(item, path)));
    return expression.items.reduce((acc, item) => combine(acc, expand(item, path)), [{ courses: [], unresolved: [] }] as Alternative[]);
  };
  const rankAlternatives = (rows: Alternative[]) => unique(rows).map((row) => { const credits = row.courses.reduce((sum, id) => sum + (courses.get(id)?.credits ?? 0), 0); return { ...row, credits, score: credits - row.courses.reduce((v, id) => v + (preferences[id] ?? 0), 0), creditsComplete: row.courses.every((id) => courses.get(id)?.credits !== undefined) }; }).sort((a, b) => a.unresolved.length - b.unresolved.length || Number(b.creditsComplete) - Number(a.creditsComplete) || a.score - b.score || a.courses.join().localeCompare(b.courses.join()));
  for (const [id, course] of courses) {
    const node = nodes.get(id)!; if (completed.has(id)) continue;
    const prerequisites = course.prerequisites ? expand(course.prerequisites, new Set([id])) : [{ courses: [], unresolved: [`Unverified prerequisites: ${id}`] }];
    const ranked = rankAlternatives(prerequisites), best = ranked[0];
    node.state = planned.has(id) ? "planned" : !best || best.unresolved.length ? "unknown" : best.courses.length ? "blocked" : "available";
    // A preference-weighted favorite is not necessarily the credit minimum. Unknown
    // alternatives also prevent proving a minimum, even when a known path exists.
    if (ranked.length && ranked.every((alternative) => alternative.creditsComplete && !alternative.unresolved.length)) {
      node.minimumAdditionalCredits = Math.min(...ranked.map((alternative) => alternative.credits));
    }
  }
  const targets = (request.goals?.length ? request.goals : [...planned]).map(normalize);
  const alternatives = rankAlternatives(expand({ kind: "all", items: targets.map((course) => ({ kind: "course", course })) }, new Set()));
  const bestCourses = new Set(alternatives[0]?.courses ?? []);
  for (const node of nodes.values()) if (node.kind === "course") node.rank = completed.has(node.id) ? 0 : bestCourses.has(node.id) ? 1 : 2;
  if (truncated) {
    for (const node of nodes.values()) delete node.minimumAdditionalCredits;
    warnings.add("Search was truncated: rankings cover explored alternatives only, not a proven global optimum.");
  }
  return { nodes: [...nodes.values()], edges, alternatives, truncated, warnings: [...warnings], ranking: "Unique remaining-course credits minus explicit preference weights; unknown prerequisites and missing credits are flagged. Not an official degree-completion verdict." };
}
