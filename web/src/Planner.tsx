import { useCallback, useEffect, useRef, useState } from "react"
import * as d3 from "d3"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"

type Obj = Record<string, any>
type Node = d3.SimulationNodeDatum & { id: string; label: string; kind: string; state: string; description?: string; course?: Obj; metadata?: Obj; reportSequence?: number; entrySequence?: number; hasPossibleCourses?: boolean; rank?: number }
type Graph = { nodes: Node[]; edges: { source: string; target: string; relation: string; weight?: number }[]; note?: string; ranking?: string; alternatives?: Obj[]; truncated?: boolean }
export type RunOperation = (name: string, args: Obj) => Promise<any>
const courseIdentity = (course: Obj) => ({
  id: String(course.metadata?.courseId ?? course.courseId ?? course.id),
  offerNumber: Number(course.metadata?.offerNumber ?? course.courseOfferNumber ?? course.offerNumber ?? 1),
  course: String(typeof course.course === "string" ? course.course : course.label ?? course.displayName),
})
const clock = (minutes: number) => `${Math.floor(minutes / 60).toString().padStart(2, "0")}:${(minutes % 60).toString().padStart(2, "0")}`
const colors: Record<string, string> = { completed: "#15803d", satisfied: "#15803d", waived: "#15803d", planned: "#2563eb", "in-progress": "#0891b2", needed: "#d97706", blocked: "#d97706", available: "#059669", unknown: "#64748b", official: "#7c3aed" }
function DegreeCanvas({ graph, onSelect }: { graph: Graph; onSelect: (node: Node) => void }) {
  const svg = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!svg.current) return
    const root = d3.select(svg.current); root.selectAll("*").remove()
    const nodes = graph.nodes.map((n) => ({ ...n })), edges = graph.edges.map((e) => ({ ...e }))
    const width = 900, height = 620
    root.attr("viewBox", `0 0 ${width} ${height}`)
    root.append("defs").append("marker").attr("id", "degree-arrow").attr("viewBox", "0 -5 10 10").attr("refX", 24).attr("markerWidth", 5).attr("markerHeight", 5).attr("orient", "auto").append("path").attr("d", "M0,-5L10,0L0,5").attr("fill", "#94a3b8")
    const layer = root.append("g")
    root.call(d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.15, 5]).on("zoom", (event) => layer.attr("transform", event.transform)))
    const lines = layer.append("g").selectAll("line").data(edges).join("line").attr("stroke", "#94a3b8").attr("stroke-opacity", 0.45).attr("marker-end", "url(#degree-arrow)")
    const group = layer.append("g").selectAll<SVGGElement, Node>("g").data(nodes).join("g").attr("tabindex", 0).attr("role", "button").attr("aria-label", (n) => `${n.label}, ${n.state}`).style("cursor", "pointer").on("click", (_, n) => onSelect(n)).on("keydown", (event, n) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(n) } })
    group.append("circle").attr("r", (n) => n.kind === "course" ? 10 : 14).attr("fill", (n) => colors[n.state] ?? "#64748b").attr("stroke", (n) => n.rank === 1 ? "#facc15" : "white").attr("stroke-width", (n) => n.rank === 1 ? 3 : 1)
    group.append("text").text((n) => n.label.length > 34 ? `${n.label.slice(0, 32)}…` : n.label).attr("x", 17).attr("dy", 4).attr("font-size", 10).attr("fill", "currentColor")
    group.append("title").text((n) => `${n.label}\n${n.description ?? n.course?.description ?? ""}\n${n.state}`)
    const simulation = d3.forceSimulation(nodes).randomSource(d3.randomLcg(0.5)).force("link", d3.forceLink<Node, any>(edges).id((n) => n.id).distance(65)).force("charge", d3.forceManyBody().strength(-180)).force("center", d3.forceCenter(width / 2, height / 2)).force("collision", d3.forceCollide(26))
    group.call(d3.drag<SVGGElement, Node>().on("start", (e, n) => { if (!e.active) simulation.alphaTarget(0.3).restart(); n.fx = n.x; n.fy = n.y }).on("drag", (e, n) => { n.fx = e.x; n.fy = e.y }).on("end", (e, n) => { if (!e.active) simulation.alphaTarget(0); n.fx = null; n.fy = null }))
    simulation.on("tick", () => { lines.attr("x1", (e: any) => e.source.x).attr("y1", (e: any) => e.source.y).attr("x2", (e: any) => e.target.x).attr("y2", (e: any) => e.target.y); group.attr("transform", (n) => `translate(${n.x},${n.y})`) })
    return () => { simulation.stop() }
  }, [graph, onSelect])
  return <svg ref={svg} aria-label="Interactive directed degree graph. Drag nodes or zoom; select a node for details." className="h-[620px] w-full rounded-lg border bg-muted/20" />
}
export function PlannerPage({ run }: { run: RunOperation }) {
  const [graph, setGraph] = useState<Graph | null>(null), [official, setOfficial] = useState<Graph | null>(null)
  const [selected, setSelected] = useState<Node | null>(null), [options, setOptions] = useState<Obj[]>([]), [metadata, setMetadata] = useState<Obj | null>(null)
  const [search, setSearch] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState("")
  const [courseSearch, setCourseSearch] = useState(""), [courseResults, setCourseResults] = useState<Obj[]>([])
  const [sections, setSections] = useState<Obj[] | null>(null), [professors, setProfessors] = useState<Record<string, Obj>>({})
  const [optionSearch, setOptionSearch] = useState("")
  const execute = async (label: string, work: () => Promise<void>) => { setBusy(label); setError(""); try { await work() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy("") } }
  const select = useCallback((node: Node) => { setSelected(node); setOptions([]); setMetadata(null); setSections(null); setProfessors({}); setOptionSearch("") }, [])
  const load = () => execute("Loading your official audit…", async () => { const result = await run("degree.graph", {}); setGraph(result); setOfficial(result); if (result.nodes[0]) select(result.nodes[0]); else setSelected(null) })
  const prerequisiteMap = (course: Obj) => execute("Following prerequisite alternatives…", async () => {
    const goal = courseIdentity(course)
    const pending = [goal]
    const identities = new Map<string, Obj>()
    const seen = new Set<string>(), all: Obj[] = []
    while (pending.length) {
      const item = pending.shift()!; if (seen.has(item.course)) continue; seen.add(item.course)
      setBusy(`Reading prerequisites: ${seen.size} courses…`)
      const detail = await run("courses.detail", { id: item.id, offerNumber: item.offerNumber })
      identities.set(item.course, { courseId: item.id, offerNumber: item.offerNumber })
      const credits = Number(/Units:\s*(\d+(?:\.\d+)?)/.exec(detail.text)?.[1])
      all.push({ course: item.course, description: detail.description ?? "", ...(Number.isFinite(credits) ? { credits } : {}), prerequisites: detail.prerequisites })
      const references: string[] = []
      const visit = (e: Obj) => { if (e.kind === "course") references.push(e.course); else if (Array.isArray(e.items)) e.items.forEach(visit) }
      visit(detail.prerequisites)
      for (const code of references) if (!seen.has(code) && !pending.some((c) => c.course === code)) {
        const found = await run("courses.search", { keywords: code })
        const match = found.courses.find((c: Obj) => c.course === code)
        if (match) pending.push(match)
      }
    }
    const completed = official?.nodes.filter((n) => n.state === "completed").map((n) => n.label) ?? []
    const planned = official?.nodes.filter((n) => n.state === "planned").map((n) => n.label) ?? []
    const result = await run("planner.graph", { courses: all, completed, planned, goals: [goal.course] })
    setGraph({ ...result, nodes: result.nodes.map((node: Node) => ({ ...node, metadata: identities.get(node.label) })) }); setSelected(null); setOptions([]); setMetadata(null); setSections(null); setProfessors({})
  })
  const expandOptions = (node: Node) => execute("Loading official alternatives…", async () => {
    const courses = (await run("degree.options", { reportSequence: node.reportSequence, entrySequence: node.entrySequence })).courses as Obj[]
    setOptions(courses); setOptionSearch("")
    if (graph) {
      const nodes = new Map(graph.nodes.map((item) => [item.id, item]))
      const edges = [...graph.edges]
      for (const [index, course] of courses.entries()) {
        const id = course.wildcard || !course.courseId ? `${node.id}:option:${index}` : `course:${course.courseId}`
        if (!nodes.has(id)) nodes.set(id, { id, kind: course.wildcard ? "requirement" : "course", label: String(course.displayName), description: String(course.longTitle ?? course.title ?? ""), state: "unknown", metadata: course.wildcard ? { wildcard: true } : { courseId: course.courseId, offerNumber: Number(course.courseOfferNumber ?? 1) } })
        if (!edges.some((edge) => edge.source === id && edge.target === node.id)) edges.push({ source: id, target: node.id, relation: "official-alternative" })
      }
      const expanded = { ...graph, nodes: [...nodes.values()], edges }
      setOfficial(expanded)
      setGraph(expanded)
    }
  })
  const showSections = (node: Node) => execute("Loading current section offerings…", async () => {
    const result = await run("courses.sections", { keywords: node.label })
    setSections(result.sections.filter((section: Obj) => section.course === node.label))
    setProfessors({})
  })
  return <div className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-semibold">Your path through Vanderbilt</h2><p className="text-sm text-muted-foreground">Official degree requirements, your planner, and every discovered prerequisite branch.</p></div><Button onClick={load} disabled={!!busy}>{official ? "Refresh audit" : "Load my degree audit"}</Button></div>
    {busy && <p role="status" className="text-sm">{busy}</p>}{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); execute("Searching the catalog…", async () => setCourseResults((await run("courses.search", { keywords: courseSearch })).courses)) }}><Input aria-label="Search official course catalog" value={courseSearch} onChange={(e) => setCourseSearch(e.target.value)} placeholder="Explore a course, e.g. CS 3251" /><Button type="submit" variant="secondary" disabled={!!busy || courseSearch.length < 3}>Find courses</Button></form>
    {courseResults.length > 0 && <div className="flex flex-wrap gap-2">{courseResults.map((c) => <Button key={c.id} variant="outline" disabled={!!busy} onClick={() => prerequisiteMap(c)}>{c.course} · {c.title}</Button>)}</div>}
    {graph ? <>
      <div className="flex flex-wrap items-center gap-3 text-xs">{[["#15803d", "Satisfied / completed"], ["#2563eb", "Planned"], ["#d97706", "Still needed"], ["#64748b", "Unverified"], ["#facc15", "Lowest-cost path"]].map(([color, label]) => <span key={label} className="flex items-center gap-1"><span style={{ background: color }} className="inline-block size-3 rounded-full" />{label}</span>)}{graph !== official && official && <Button size="sm" variant="outline" onClick={() => { setGraph(official); setSelected(null); setOptions([]); setMetadata(null); setSections(null); setProfessors({}) }}>Back to official audit</Button>}</div>
      <DegreeCanvas graph={graph} onSelect={select} />
      <p className="text-xs text-muted-foreground">{graph.note ?? graph.ranking} {graph.truncated ? "Path enumeration is truncated; the displayed ranking is not globally optimal." : ""}</p>
      {graph.alternatives && <Card><CardHeader><CardTitle>Ranked prerequisite paths</CardTitle><CardDescription>Shared prerequisites count once. Expand a path to see its course set.</CardDescription></CardHeader><CardContent>{graph.alternatives.slice(0, 20).map((p, i) => <details key={i} className="border-b py-2"><summary>Path {i + 1} · {p.creditsComplete ? `${p.credits} credits` : "credits incomplete"} · {p.unresolved.length ? `${p.unresolved.length} unverified requirements` : "prerequisites mapped"}</summary><p className="py-2 text-sm">{p.courses.join(", ")}</p>{p.unresolved.map((x: string) => <p key={x} className="text-xs text-amber-700">{x}</p>)}</details>)}{graph.alternatives.length > 20 && <p className="text-xs">Showing 20 of {graph.alternatives.length} paths; the full result is available through planner.graph.</p>}</CardContent></Card>}
      <div className="grid gap-4 md:grid-cols-2"><Card><CardHeader><CardTitle>Explore requirements</CardTitle><Input aria-label="Filter graph nodes" placeholder="Find a course or requirement" value={search} onChange={(e) => setSearch(e.target.value)} /></CardHeader><CardContent className="max-h-80 overflow-auto">{graph.nodes.filter((n) => `${n.label} ${n.description}`.toLowerCase().includes(search.toLowerCase())).map((n) => <button className="flex w-full items-center justify-between border-b py-2 text-left text-sm" key={n.id} onClick={() => select(n)}><span>{n.label}</span><Badge variant="outline">{n.state}</Badge></button>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>{selected?.label ?? "Select a node"}</CardTitle><CardDescription>{selected?.description ?? selected?.course?.description ?? "Drag to rearrange the graph. Use scroll to zoom, or select from the accessible list."}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">{selected && <><Badge variant="outline">{selected.state}</Badge>{selected.hasPossibleCourses && <Button disabled={!!busy} onClick={() => expandOptions(selected)}>Show official course alternatives</Button>}{selected.metadata?.courseId && <><Button variant="outline" disabled={!!busy} onClick={() => execute("Reading course metadata…", async () => setMetadata(await run("courses.detail", { id: String(selected.metadata!.courseId), offerNumber: Number(selected.metadata!.offerNumber ?? 1) })))}>Official course details</Button><Button variant="outline" disabled={!!busy} onClick={() => prerequisiteMap(selected)}>Map all prerequisites</Button><Button variant="outline" disabled={!!busy} onClick={() => showSections(selected)}>Current sections & professors</Button></>}{metadata && <div className="text-sm"><p>{metadata.description}</p><p className="mt-2 font-medium">Prerequisites: {metadata.prerequisiteText ?? "Not verified from the source"}</p></div>}{sections !== null && <div className="space-y-3 text-sm"><h3 className="font-medium">Current section offerings</h3>{!sections.length && <p>No sections returned for the current YES term.</p>}{sections.map((section) => <div key={section.id} className="rounded border p-3"><p className="font-medium">{section.course}-{section.section} · {section.component} · {section.credits} credits</p><p className="text-xs text-muted-foreground">{section.termCode ? `Term ${section.termCode} · ` : ""}{section.availability}</p>{section.meetings.map((meeting: Obj, index: number) => <p key={index}>{meeting.days.join("")} {clock(meeting.start)}–{clock(meeting.end)} · {meeting.location || "Room TBA"}</p>)}{section.timeUnknown && <p>Time TBA: conflicts cannot be verified.</p>}{(section.instructors ?? []).map((name: string) => <div key={name} className="mt-2"><span>{name} </span>{!/^(staff|tba)$/i.test(name) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => execute("Looking up public professor ratings…", async () => { const result = await run("professors.search", { name }); setProfessors((current) => ({ ...current, [name]: result })) })}>Professor ratings</Button>}{professors[name] && <div className="mt-2 text-xs"><p>{professors[name].note}</p>{!professors[name].professors.length && <p>No matching public ratings.</p>}{professors[name].professors.map((professor: Obj) => <p key={professor.id}><a className="underline" href={professor.url} target="_blank" rel="noopener noreferrer">{professor.name}</a> · {professor.department} · {professor.count ? `${professor.rating}/5 (${professor.count} ratings)` : "Not rated"} · difficulty {professor.difficulty}/5{professor.wouldTakeAgainPercent >= 0 ? ` · ${professor.wouldTakeAgainPercent}% would take again` : ""}{!professor.exactNameMatch && " · Verify this match"}</p>)}</div>}</div>)}</div>)}</div>}{options.length > 0 && <><p className="text-sm">{options.length.toLocaleString()} official alternatives, also added to the graph.</p><Input aria-label="Filter official alternatives" placeholder="Filter official alternatives" value={optionSearch} onChange={(event) => setOptionSearch(event.target.value)} /><div className="max-h-72 overflow-auto">{options.filter((c) => `${c.displayName} ${c.longTitle}`.toLowerCase().includes(optionSearch.toLowerCase())).slice(0, 100).map((c, i) => <p key={`${c.courseId}:${i}`} className="border-b py-2 text-sm">{c.displayName} · {c.longTitle ?? c.title}{c.wildcard && <Badge variant="outline">Wildcard</Badge>}</p>)}</div></>}</>}</CardContent></Card></div>
    </> : <Card><CardHeader><CardTitle>Start with Vanderbilt's own requirements</CardTitle><CardDescription>Load your official audit to see what is complete, what is left, and the courses already in your planner. No enrollment or planner changes are made.</CardDescription></CardHeader></Card>}
  </div>
}
