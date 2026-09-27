import type { CookieRecord } from "../vault/file-store.js";
import { CookieJar, jarFetch } from "./jar.js";
import { parseCourseDetail, parseCourseResults, parseSectionResults } from "./more-parser.js";

export type JsonObject = { [key: string]: unknown };
export interface OfficialAuditSnapshot {
  audits: JsonObject[];
  plannerCourses: JsonObject[];
  source: "live";
  fetchedAt: string;
}
const LANDING = "https://landing.app.vanderbilt.edu/landing/student-landing";
const SAM = "https://sam.app.vanderbilt.edu/sam/";
const MORE = "https://more.app.vanderbilt.edu/more/";

/** Read-only adapters to routes advertised by Vanderbilt's own current pages/scripts. */
export class YesPlanningClient {
  private jar: CookieJar;
  private auditReady = false;
  private moreReady = false;
  constructor(private readonly options: { cookies: CookieRecord[]; fetchImpl?: typeof fetch }) { this.jar = new CookieJar(options.cookies); }

  private async get(url: string) {
    const result = await jarFetch(url, { jar: this.jar, fetchImpl: this.options.fetchImpl });
    if (result.status !== 200 || new URL(result.finalUrl).hostname === "onevu.vanderbilt.edu") {
      throw new Error(`YES planning read failed at ${new URL(url).pathname}: ${result.status === 200 ? "session requires refresh" : `HTTP ${result.status}`}`);
    }
    return result;
  }
  private async auditSession() {
    if (this.auditReady) return;
    const landing = await this.get(LANDING);
    const link = /href=["'](https:\/\/sam\.app\.vanderbilt\.edu\/sam\/degree-audit[^"']*)["']/i.exec(landing.text)?.[1];
    if (!link) throw new Error("YES landing page no longer supplies the account's degree-audit link");
    const page = await this.get(link.replace(/&amp;/g, "&"));
    if (!page.text.includes("degree-audit.controller.js")) throw new Error("YES degree-audit shell changed or account access is unavailable");
    this.auditReady = true;
  }
  private async moreSession() {
    if (!this.moreReady) { await this.get(MORE + "SearchClasses!input.action"); this.moreReady = true; }
  }
  private async auditJson(name: string, query?: Record<string, string | number>) {
    await this.auditSession();
    const url = new URL("load-" + name, SAM);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const result = await this.get(url.href);
    if (!result.contentType.includes("json")) throw new Error(`YES ${name} returned a non-JSON response; refresh the session`);
    return JSON.parse(result.text) as unknown;
  }
  async degreeAudit(): Promise<OfficialAuditSnapshot> {
    const audits = await this.auditJson("basic-audits");
    const plannerCourses = await this.auditJson("planner-courses");
    if (!Array.isArray(audits) || !Array.isArray(plannerCourses)) throw new Error("YES audit/planner response schema changed");
    return { audits, plannerCourses, source: "live", fetchedAt: new Date().toISOString() };
  }
  /** Fetch only the requested line, using the identity/report/career from the authenticated audit. */
  async courseSatisfiers(reportSequence: number, entrySequence: number) {
    const audits = await this.auditJson("basic-audits");
    if (!Array.isArray(audits)) throw new Error("YES audits response schema changed");
    const audit = audits.find((a: JsonObject) => a.reportSequence === reportSequence) as JsonObject | undefined;
    if (!audit) throw new Error("Requested report is not in the authenticated student's degree audit");
    const career = audit.career as JsonObject;
    const lines = (audit.requirementGroups as JsonObject[]).flatMap((g) => g.requirements as JsonObject[]).flatMap((r) => r.requirementLines as JsonObject[]);
    if (!lines.some((line) => line.entrySequence === entrySequence && line.hasPossibleCourses)) throw new Error("Requested audit line has no available course alternatives");
    const result = await this.auditJson("course-satisfiers", { commodoreId: String(audit.commodoreId), reportSequence, careerCode: String(career.code), entrySequence });
    if (!Array.isArray(result)) throw new Error("YES course-satisfiers response schema changed");
    return result as JsonObject[];
  }
  async searchCourses(keywords: string) {
    await this.moreSession();
    const url = new URL("SearchCoursesExecute!search.action", MORE); url.searchParams.set("keywords", keywords);
    const result = await this.get(url.href); return { courses: parseCourseResults(result.text), source: "live" as const };
  }
  async searchSections(keywords: string, termCode?: string) {
    await this.moreSession();
    const url = new URL("SearchClassesExecute!search.action", MORE); url.searchParams.set("keywords", keywords);
    if (termCode) url.searchParams.set("selectedTermCode", termCode);
    const result = await this.get(url.href); const sections = parseSectionResults(result.text);
    if (termCode && sections.some((s) => s.termCode !== termCode)) throw new Error("YES did not honor the requested term; refusing mismatched results");
    return { sections, source: "live" as const };
  }
  async courseDetail(id: string, offerNumber = 1) {
    await this.moreSession();
    const url = new URL("GetCourseDetail.action", MORE); url.searchParams.set("id", id); url.searchParams.set("offerNumber", String(offerNumber));
    const result = await this.get(url.href); return { id, offerNumber, ...parseCourseDetail(result.text) };
  }
}
