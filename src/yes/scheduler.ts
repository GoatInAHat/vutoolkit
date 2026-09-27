/** Portable schedule enumeration. No enrollment or network access. Times are local campus minutes. */
export interface Meeting {
  days: string[];
  start: number;
  end: number;
  location?: string;
}

export interface ScheduleSection {
  id: string;
  course: string;
  section: string;
  component: string;
  termCode?: string;
  title?: string;
  credits?: number;
  instructors?: string[];
  meetings: Meeting[];
  timeUnknown?: boolean;
  availability?: string;
  /** A linked lecture/lab's allowed companion section IDs, if the source provides them. */
  compatibleWith?: string[];
}

export interface ScheduleRequest {
  sections: ScheduleSection[];
  excludedCourses?: string[];
  excludedSectionIds?: string[];
  blockedTimes?: Meeting[];
  hidePreferenceConflicts?: boolean;
  limit?: number;
  maxSearchNodes?: number;
}

export function overlapMinutes(a: Meeting, b: Meeting): number {
  const sharedDays = new Set(a.days.filter((day) => b.days.includes(day))).size;
  return sharedDays * Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function sectionsConflict(a: ScheduleSection, b: ScheduleSection): boolean {
  if (a.course === b.course && a.component !== b.component) {
    if (a.compatibleWith && !a.compatibleWith.includes(b.id)) return true;
    if (b.compatibleWith && !b.compatibleWith.includes(a.id)) return true;
  }
  return a.meetings.some((x) => b.meetings.some((y) => overlapMinutes(x, y) > 0));
}

/** Exact enumeration until the caller's explicit result/search bounds, with honest truncation. */
export function solveSchedules(request: ScheduleRequest) {
  const excluded = new Set(request.excludedCourses ?? []);
  const excludedSections = new Set(request.excludedSectionIds ?? []);
  const limit = request.limit ?? 1000;
  const maxSearchNodes = request.maxSearchNodes ?? 250000;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxSearchNodes) || maxSearchNodes < 1) {
    throw new Error("Schedule limits must be positive integers");
  }
  const ids = new Set<string>();
  const terms = new Set<string>();
  for (const section of request.sections) {
    if (ids.has(section.id)) throw new Error(`Duplicate section ID: ${section.id}`);
    ids.add(section.id);
    if (section.termCode) terms.add(section.termCode);
    for (const meeting of section.meetings) {
      if (!Number.isFinite(meeting.start) || !Number.isFinite(meeting.end) || meeting.start < 0 || meeting.end > 1440 || meeting.end <= meeting.start) {
        throw new Error(`Invalid meeting time for section ${section.id}`);
      }
    }
  }
  if (terms.size > 1) throw new Error("A schedule must contain sections from one term only");
  const grouped = new Map<string, ScheduleSection[]>();
  for (const section of request.sections.filter((s) => !excluded.has(s.course))) {
    const key = `${section.course} · ${section.component}`;
    // Excluding individual sections must not silently remove a required course/component.
    // An empty group correctly makes the requested schedule infeasible.
    if (!grouped.has(key)) grouped.set(key, []);
    if (!excludedSections.has(section.id)) grouped.get(key)!.push(section);
  }
  const groups = [...grouped.entries()].sort(([a, x], [b, y]) => x.length - y.length || a.localeCompare(b));
  const penalty = (section: ScheduleSection) => section.meetings.reduce((sum, m) =>
    sum + (request.blockedTimes ?? []).reduce((p, b) => p + overlapMinutes(m, b), 0), 0);
  const schedules: { sections: ScheduleSection[]; preferenceConflictMinutes: number; unknownTimeSections: string[] }[] = [];
  let searched = 0;
  let found = 0;
  let searchTruncated = false;
  const key = (s: { sections: ScheduleSection[] }) => s.sections.map((x) => x.id).sort().join("|");
  const compare = (a: typeof schedules[number], b: typeof schedules[number]) =>
    a.preferenceConflictMinutes - b.preferenceConflictMinutes || key(a).localeCompare(key(b));
  const walk = (i: number, selected: ScheduleSection[], score: number) => {
    if (++searched > maxSearchNodes) { searchTruncated = true; return; }
    if (i === groups.length) {
      if (!selected.length) return;
      found++;
      schedules.push({ sections: [...selected], preferenceConflictMinutes: score, unknownTimeSections: selected.filter((s) => s.timeUnknown || !s.meetings.length).map((s) => s.id) });
      if (schedules.length > limit * 2) { schedules.sort(compare); schedules.length = limit; }
      return;
    }
    for (const candidate of groups[i]![1].slice().sort((a, b) => a.id.localeCompare(b.id))) {
      if (searchTruncated) break;
      const added = penalty(candidate);
      if (request.hidePreferenceConflicts && added > 0) continue;
      if (selected.some((s) => sectionsConflict(candidate, s))) continue;
      walk(i + 1, [...selected, candidate], score + added);
    }
  };
  walk(0, [], 0);
  schedules.sort(compare);
  schedules.length = Math.min(schedules.length, limit);
  const incompatibleGroups: [string, string][] = [];
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    if (groups[i]![1].length && groups[j]![1].length && groups[i]![1].every((a) => groups[j]![1].every((b) => sectionsConflict(a, b)))) incompatibleGroups.push([groups[i]![0], groups[j]![0]]);
  }
  const warnings = groups.filter(([, sections]) => !sections.length).map(([group]) => `No eligible sections remain for required group ${group}. Exclude the course explicitly to omit it.`);
  if (request.sections.some((s) => s.timeUnknown || !s.meetings.length)) warnings.push("TBA/unknown meeting times cannot be checked for conflicts; verify them before choosing a schedule.");
  return {
    schedules, found, searched, truncated: searchTruncated || found > limit, searchComplete: !searchTruncated,
    incompatibleGroups, excludedCourses: [...excluded], excludedSectionIds: [...excludedSections],
    warnings,
  };
}

/** Selection changes the cart only. Unknown/unselected course groups are retained by default. */
export function cartDifference(currentIds: string[], chosen: ScheduleSection[], candidates: ScheduleSection[], keepExcluded = true, preserveSectionIds: string[] = []) {
  const selected = new Set(chosen.map((s) => s.id));
  const includedGroups = new Set(chosen.map((s) => `${s.course}|${s.component}`));
  const removable = new Set(candidates.filter((s) => !keepExcluded || (includedGroups.has(`${s.course}|${s.component}`) && !preserveSectionIds.includes(s.id))).map((s) => s.id));
  return {
    add: [...selected].filter((id) => !currentIds.includes(id)),
    remove: currentIds.filter((id) => !selected.has(id) && removable.has(id)),
    unchanged: currentIds.filter((id) => selected.has(id) || !removable.has(id)),
  };
}
