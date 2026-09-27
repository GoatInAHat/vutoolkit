import { parseSectionResults } from "../../../src/yes/more-parser";
import { cartDifference, solveSchedules, type Meeting, type ScheduleSection } from "../../../src/yes/scheduler";
export interface SchedulerPreferences { excludedCourses: string[]; excludedSectionIds: string[]; blockedTimes: Meeting[]; hidePreferenceConflicts: boolean; keepExcluded: boolean }
const defaults: SchedulerPreferences = { excludedCourses: [], excludedSectionIds: [], blockedTimes: [], hidePreferenceConflicts: false, keepExcluded: true };
const cartRoot = () => document.querySelector<HTMLElement>("#studentCart_content, #studentCart, #cartDiv");
const sectionsAt = (root: Element) => {
  const clean = root.cloneNode(true) as Element;
  clean.querySelectorAll(".vutoolkit-professor-rating, .vutoolkit-add-alternatives").forEach((node) => node.remove());
  return parseSectionResults(clean.outerHTML);
};
const selectedTerm = () => (document.querySelector("#selectedTerm") as HTMLSelectElement | null)?.value ?? "";
function button(label: string, action: () => void | Promise<void>): HTMLButtonElement { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.addEventListener("click", () => void action()); return b; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) { const e = document.createElement(tag); if (text) e.textContent = text; return e; }
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every executed page action is an exact cart link, never an enrollment control. */
export async function clickCartAction(id: string, action: "add" | "remove", root: Element = document.body) {
  const selector = action === "add" ? 'a[title="Add this class to your cart"]' : 'a[title="Remove Class From Cart"]';
  const cells = [...root.querySelectorAll<HTMLElement>(`[id="classNumber_${CSS.escape(id)}"]`)];
  const link = cells.map((c) => c.closest("tr")?.querySelector<HTMLAnchorElement>(selector)).find(Boolean);
  if (!link) throw new Error(`YES no longer offers a cart ${action} action for section ${id}. Nothing was enrolled.`);
  link.click();
  for (let i = 0; i < 30; i++) { await delay(200); const ids = cartRoot() ? sectionsAt(cartRoot()!).map((s) => s.id) : []; if (action === "add" ? ids.includes(id) : !ids.includes(id)) return; }
  throw new Error(`Could not verify the cart ${action} for section ${id}; refresh YES before continuing.`);
}
export function mountYesScheduler({ loadPreferences, savePreferences, professorSearch }: { loadPreferences: () => Promise<Partial<SchedulerPreferences>>; savePreferences: (p: SchedulerPreferences) => Promise<void>; professorSearch?: (name: string) => Promise<any> }) {
  if (document.querySelector("#vutoolkit-scheduler")) return;
  const host = element("div"); host.id = "vutoolkit-scheduler"; document.body.prepend(host);
  const shadow = host.attachShadow({ mode: "open" }); const style = element("style");
  style.textContent = `:host{display:block;font:14px system-ui;color:#17212b}*{box-sizing:border-box}button,input{font:inherit}button{border:1px solid #cbd5e1;border-radius:7px;background:white;color:#17212b;padding:8px 12px;cursor:pointer}button:hover{background:#e8eff9}button:disabled{opacity:.5;cursor:wait}.bar{display:flex;align-items:center;gap:10px;padding:12px;background:#f0f5fb;border-bottom:1px solid #dce5f0}.status{font-size:12px;color:#445}.overlay{position:fixed;inset:0;background:#10203077;z-index:2147483647;display:flex;align-items:center;justify-content:center}.dialog{background:#fff;max-width:1100px;width:94vw;max-height:90vh;overflow:auto;padding:24px;border-radius:14px;box-shadow:0 20px 100px #1238}h2{margin-top:0}.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0}label{display:block;margin:9px 0}input[type=time]{padding:5px}.cards{display:grid;gap:18px}.card{border:1px solid #d7e0eb;border-radius:10px;padding:16px}.week{display:grid;grid-template-columns:repeat(7,minmax(90px,1fr));overflow:auto;gap:4px}.day{border:1px solid #e5e9ef;border-radius:5px;min-height:90px;padding:6px}.class{padding:6px;margin:5px 0;background:#e9f2ff;border-left:3px solid #2870c7;font-size:12px}.muted{font-size:12px;color:#536375}.warn{color:#9b5c00}.bad{color:#b42318}`;
  shadow.append(style); const bar = element("div"); bar.className = "bar"; const status = element("span"); status.className = "status";
  bar.append(element("strong", "vutoolkit"), button("Make schedule", () => makeSchedule()), button("Preferences", () => preferencesDialog()), status); shadow.append(bar);
  let prefs = { ...defaults }; let currentDialog: HTMLElement | null = null;
  const preferencesReady = loadPreferences().then((p) => { prefs = { ...defaults, ...p } }).catch(() => { status.textContent = "Preferences could not be loaded." });
  const close = () => { currentDialog?.remove(); currentDialog = null };
  const dialog = (title: string) => { close(); const overlay = element("div"), box = element("section"); overlay.className = "overlay"; box.className = "dialog"; box.setAttribute("role", "dialog"); box.setAttribute("aria-label", title); box.setAttribute("aria-modal", "true"); box.append(element("h2", title), button("Close", close)); overlay.append(box); shadow.append(overlay); currentDialog = overlay; box.tabIndex = -1; box.focus(); return box };
  shadow.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") close() });
  async function preferencesDialog() {
    await preferencesReady;
    const box = dialog("Schedule preferences"); const working = structuredClone(prefs);
    box.append(element("p", "Choose courses to include and times you prefer to keep free. These preferences do not change your cart."));
    const cartSections = cartRoot() ? sectionsAt(cartRoot()!) : [];
    const courses = [...new Set(cartSections.map((s) => s.course))];
    for (const course of courses) { const label = element("label"), check = element("input"); check.type = "checkbox"; check.checked = !working.excludedCourses.includes(course); check.onchange = () => { working.excludedCourses = check.checked ? working.excludedCourses.filter((c) => c !== course) : [...working.excludedCourses, course] }; label.append(check, document.createTextNode(` ${course}`)); box.append(label);
      for (const section of cartSections.filter((s) => s.course === course)) { const sub = element("label"), include = element("input"); sub.style.marginLeft = "24px"; include.type = "checkbox"; include.checked = !working.excludedSectionIds.includes(section.id); include.onchange = () => { working.excludedSectionIds = include.checked ? working.excludedSectionIds.filter((id) => id !== section.id) : [...working.excludedSectionIds, section.id] }; sub.append(include, document.createTextNode(` Section ${section.section} · ${section.component} · ${section.instructors?.join(", ") ?? "TBA"}`)); box.append(sub) }
    }
    for (const [key, text] of [["keepExcluded", "Keep excluded courses in the cart when selecting a schedule"], ["hidePreferenceConflicts", "Hide schedules that overlap preferred free times"]] as const) { const label = element("label"), check = element("input"); check.type = "checkbox"; check.checked = working[key]; check.onchange = () => { working[key] = check.checked }; label.append(check, document.createTextNode(` ${text}`)); box.append(label) }
    const blocks = element("div"); const renderBlocks = () => { blocks.replaceChildren(); for (const [i, block] of working.blockedTimes.entries()) { const row = element("div"); row.className = "row"; row.append(element("span", `${block.days.join("")} ${clock(block.start)}–${clock(block.end)}`), button("Remove", () => { working.blockedTimes.splice(i, 1); renderBlocks() })); blocks.append(row) } }; renderBlocks(); box.append(element("h3", "Preferred free times"), blocks);
    const add = element("div"); add.className = "row"; const days: string[] = []; for (const day of ["M", "T", "W", "R", "F", "S", "U"]) { const label = element("label"), check = element("input"); check.type = "checkbox"; check.onchange = () => { if (check.checked) days.push(day); else days.splice(days.indexOf(day), 1) }; label.append(check, document.createTextNode(day)); add.append(label) }
    const from = element("input"), to = element("input"); from.type = to.type = "time"; from.value = "12:00"; to.value = "13:00"; from.setAttribute("aria-label", "Free time start"); to.setAttribute("aria-label", "Free time end");
    const message = element("p"); add.append(from, to, button("Add free time", () => { const minutes = (s: string) => Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]); const start = minutes(from.value), end = minutes(to.value); if (!days.length || !Number.isFinite(start + end) || end <= start) { message.textContent = "Select days and an end time after the start."; return } working.blockedTimes.push({ days: [...days], start, end }); message.textContent = ""; renderBlocks() })); box.append(add, message, button("Clear free-time preferences", () => { working.blockedTimes = []; renderBlocks() }), button("Save preferences", async () => { await savePreferences(working); prefs = working; close(); status.textContent = "Preferences saved." }));
  }
  function clock(n: number) { return `${Math.floor(n / 60).toString().padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}` }
  async function makeSchedule() {
    await preferencesReady;
    const originalTerm = selectedTerm();
    const box = dialog("Choose a schedule"); const root = cartRoot(); const candidates = root ? sectionsAt(root) : [];
    if (!candidates.length) { box.append(element("p", "Your cart is empty or unavailable. Add section alternatives from the YES search results, then try again.")); return }
    const result = solveSchedules({ sections: candidates, ...prefs, limit: 5000 });
    box.append(element("p", `${result.found.toLocaleString()} conflict-free schedules${result.truncated ? " found (search/result limit reached)" : ""}. Choosing one changes only your cart, never your enrollment.`));
    result.warnings.forEach((w) => { const p = element("p", w); p.className = "warn"; box.append(p) });
    if (!result.schedules.length) { const p = element("p", result.incompatibleGroups.length ? `Conflicting course groups: ${result.incompatibleGroups.map((g) => g.join(" / ")).join("; ")}` : "No schedule satisfies all course and break-time constraints. Adjust your preferences or add other section alternatives."); p.className = "bad"; box.append(p); return }
    const list = element("div"); list.className = "cards"; box.append(list); let rendered = 0;
    const more = button("Show more schedules", () => renderNext()); box.append(more);
    const renderNext = () => { const end = Math.min(rendered + 20, result.schedules.length); for (; rendered < end; rendered++) {
      const schedule = result.schedules[rendered]!, card = element("div"); card.className = "card"; card.style.background = schedule.preferenceConflictMinutes ? "#fff8ed" : "#f4fff7"; card.append(element("h3", `Schedule ${rendered + 1} · ${schedule.preferenceConflictMinutes} preference-conflict minutes`));
      const week = element("div"); week.className = "week"; for (const day of ["M", "T", "W", "R", "F", "S", "U"]) { const col = element("div"); col.className = "day"; col.append(element("strong", day)); const meetings = schedule.sections.flatMap((s) => s.meetings.filter((m) => m.days.includes(day)).map((m) => ({ s, m }))).sort((a, b) => a.m.start - b.m.start); for (const { s, m } of meetings) { const item = element("div", `${s.course}-${s.section}\n${clock(m.start)}–${clock(m.end)}\n${m.location ?? ""}`); item.className = "class"; item.style.whiteSpace = "pre-line"; item.title = `${s.title ?? ""}\n${s.instructors?.join(", ") ?? ""}\n${s.component} · ${s.credits ?? "?"} credits`; col.append(item) } week.append(col) } card.append(week);
      const details = element("p", schedule.sections.map((s) => `${s.course}-${s.section} (${s.component}) · ${s.instructors?.join(", ") ?? "Professor TBA"}${s.timeUnknown ? " · Time TBA" : ""}`).join("; ")); details.className = "muted"; card.append(details);
      const pick = button("Use this schedule in my cart", async () => { pick.disabled = true; try { const current = cartRoot(); if (!current) throw new Error("Cart is unavailable"); if (selectedTerm() !== originalTerm || (selectedTerm() && candidates.some((s) => s.termCode && s.termCode !== selectedTerm()))) throw new Error("The selected YES term changed. Rebuild the schedule first."); const live = sectionsAt(current); const diff = cartDifference(live.map((s) => s.id), schedule.sections, candidates, prefs.keepExcluded, prefs.excludedSectionIds); if (diff.add.length) throw new Error("The cart changed since this schedule was created. Rebuild it before applying."); for (const id of diff.remove) await clickCartAction(id, "remove", cartRoot() ?? document.body); status.textContent = "Schedule verified in your cart. Enrollment was not changed."; close() } catch (e) { const p = element("p", e instanceof Error ? e.message : String(e)); p.className = "bad"; card.append(p); pick.disabled = false } }); card.append(pick); list.append(card);
    } more.hidden = rendered >= result.schedules.length }; renderNext();
  }
  const scannedProfessors = new Map<string, Promise<any>>();
  function scan() {
    document.querySelectorAll<HTMLTableElement>("table.classTable").forEach((table) => {
      if (table.querySelector(".vutoolkit-add-alternatives")) return;
      const title = table.querySelector(".classHeaderRounded"); if (!title) return;
      const addable = table.querySelector('a[title="Add this class to your cart"]'), removable = table.querySelector('a[title="Remove Class From Cart"]');
      if (!addable && !removable) return;
      const control = button(addable ? "Add all sections to cart" : "Remove course from cart", async () => {
        control.disabled = true; const sections = sectionsAt(table).filter((section) => {
          const row = table.querySelector(`[id="classNumber_${CSS.escape(section.id)}"]`)?.closest("tr");
          return Boolean(row?.querySelector(addable ? 'a[title="Add this class to your cart"]' : 'a[title="Remove Class From Cart"]'));
        }); try { for (const s of sections) await clickCartAction(s.id, addable ? "add" : "remove", addable ? document.body : cartRoot() ?? document.body); status.textContent = "Cart changes verified; enrollment unchanged." } catch (e) { status.textContent = e instanceof Error ? e.message : String(e) } finally { control.disabled = false }
      }); control.className = "vutoolkit-add-alternatives"; control.style.cssText = "margin-left:12px;padding:3px 8px;cursor:pointer"; title.append(control);
    });
    if (professorSearch) document.querySelectorAll<HTMLElement>(".classInstructor").forEach((cell) => {
      if (cell.dataset.vutoolkitRating) return; const name = cell.textContent?.trim(); if (!name || /TBA|staff/i.test(name)) return; cell.dataset.vutoolkitRating = "pending";
      let promise = scannedProfessors.get(name); if (!promise) { promise = professorSearch(name); scannedProfessors.set(name, promise) }
      promise.then((result) => { const matches = result.professors ?? []; const exact = matches.filter((p: any) => p.exactNameMatch); const match = exact.length === 1 ? exact[0] : null; const a = element("a", match ? match.count > 0 ? ` RMP ${match.rating.toFixed(1)} (${match.count})` : " RMP: not rated" : ` RMP: ${matches.length ? "choose match" : "no match"}`); a.className = "vutoolkit-professor-rating"; a.href = match?.url ?? `https://www.ratemyprofessors.com/search/professors/4002?q=${encodeURIComponent(name)}`; a.target = "_blank"; a.rel = "noopener noreferrer"; a.style.color = match ? match.rating >= 3.5 ? "#15803d" : match.rating < 2.5 ? "#b42318" : "#a16207" : "#475569"; a.title = match ? `${match.name} · difficulty ${match.difficulty} · ${match.wouldTakeAgainPercent}% would take again` : "Ratings are student-contributed; verify the professor's identity."; cell.append(a); cell.dataset.vutoolkitRating = "done" }).catch(() => { cell.dataset.vutoolkitRating = "unavailable"; const link = element("a", " RMP lookup"); link.className = "vutoolkit-professor-rating"; link.href = `https://www.ratemyprofessors.com/search/professors/4002?q=${encodeURIComponent(name)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = "Automatic ratings unavailable: connect the extension to your local vutoolkit kernel."; cell.append(link) });
    });
  }
  let queued = false; const observer = new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; scan() }, 200) } }); observer.observe(document.body, { childList: true, subtree: true }); scan();
}
