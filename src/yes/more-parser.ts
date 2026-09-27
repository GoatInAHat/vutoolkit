import type { ScheduleSection, Meeting } from "./scheduler.js";

/** HTML is data, never evaluated. Preserve line breaks for multi-meeting sections. */
export function htmlText(value: string): string {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t\r]+/g, " ").replace(/ *\n */g, "\n").trim();
}
function cell(row: string, name: string): string {
  return htmlText(new RegExp(`<td[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/td>`, "i").exec(row)?.[1] ?? "");
}
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])(?:m)?$/i.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]), minute = Number(m[2]);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  return (hour % 12 + (m[3]!.toLowerCase() === "p" ? 12 : 0)) * 60 + minute;
}
export function parseSectionResults(html: string): ScheduleSection[] {
  const sections: ScheduleSection[] = [];
  for (const table of html.matchAll(/<table\b[^>]*class=["'][^"']*\bclassTable\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi)) {
    const course = htmlText(/class=["']classAbbreviation["'][^>]*>([\s\S]*?)<\/span>/i.exec(table[1]!)?.[1] ?? "").replace(/:$/, "");
    const title = htmlText(/class=["']classDescription["'][^>]*>([\s\S]*?)<\/span>/i.exec(table[1]!)?.[1] ?? "");
    for (const row of table[1]!.matchAll(/<tr\b[^>]*class=["'][^"']*\bclassRow\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)) {
      const id = /(?:id=["']classNumber_|classNumber\s*:\s*["'])(\d+)/i.exec(row[1]!)?.[1];
      if (!id || !course) continue;
      const dayLines = cell(row[1]!, "classMeetingDays").split("\n").filter(Boolean);
      const timeLines = cell(row[1]!, "classMeetingTimes").split("\n").filter(Boolean);
      const locations = cell(row[1]!, "classBuilding").split("\n");
      const meetings: Meeting[] = [];
      let timeUnknown = !timeLines.length;
      for (let i = 0; i < timeLines.length; i++) {
        const parts = timeLines[i]!.split(/\s*[-–]\s*/);
        const start = parseClock(parts[0] ?? ""), end = parseClock(parts[1] ?? "");
        const days = (dayLines[i] ?? (dayLines.length === 1 ? dayLines[0] : "") ?? "").replace(/Th/gi, "R").match(/[MTWRFSU]/g) ?? [];
        if (start === null || end === null || end <= start || !days.length) { timeUnknown = true; continue; }
        meetings.push({ days, start, end, location: locations[i] ?? locations[0] ?? "" });
      }
      sections.push({ id, course, title, section: cell(row[1]!, "classSection"), component: cell(row[1]!, "classType"),
        credits: Number.parseFloat(cell(row[1]!, "classHours")) || 0,
        instructors: cell(row[1]!, "classInstructor").split("\n").filter(Boolean), meetings, timeUnknown,
        termCode: /termCode\s*:\s*["'](\d+)/.exec(row[1]!)?.[1], availability: cell(row[1]!, "classAvailability"),
      });
    }
  }
  return sections;
}

export function parseCourseResults(html: string) {
  const courses = [];
  const detailIdentity = /showCourseDetail\(['"](\d+)['"],\s*['"](\d+)['"]/;
  const identities = new Map<string, RegExpExecArray>();
  // YES currently puts each identity in a named helper beside its table row.
  // Parse those literal arguments as data; never evaluate the supplied scripts.
  for (const helper of html.matchAll(/function\s+(showCourseDetail_\d+)\s*\([^)]*\)\s*\{([\s\S]*?)\}/g)) {
    const id = detailIdentity.exec(helper[2]!);
    if (id) identities.set(helper[1]!, id);
  }
  const rows = [...html.matchAll(/<tr\b[^>]*class=["'][^"']*\bclassRow\b[^"']*["'][^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const row of rows) {
    // Associate identity with its own row. A missing link or an unrelated detail
    // button elsewhere on the page must never shift identities onto other courses.
    const helper = /\b(showCourseDetail_\d+)\s*\(/.exec(row[0]);
    const id = detailIdentity.exec(row[0]) ?? (helper ? identities.get(helper[1]!) : undefined);
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => htmlText(m[1]!));
    if (!id || cells.length < 6) continue;
    courses.push({ id: id[1]!, offerNumber: Number(id[2]), course: `${cells[0]} ${cells[2]}`, subject: cells[1], title: cells[3], school: cells[4], typicallyOffered: cells[5] });
  }
  return courses;
}

export function parseCourseDetail(html: string) {
  const text = htmlText(html).replace(/\s+/g, " ");
  const prerequisiteText = /(?:Requirement:\s*Prereq:|Prerequisite(?:s)?:)\s*(.*?)(?=\s+Description\b|\.\s|$)/i.exec(text)?.[1] ?? null;
  const description = /\bDescription\s+([\s\S]*?)(?:\s+Close\s*)?$/.exec(text)?.[1] ?? null;
  return { text, description, prerequisiteText, source: "YES course catalog" as const };
}
