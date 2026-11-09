import { expect, it } from "vitest";
import { parseClock, parseCourseDetail, parseCourseResults, parseSectionResults } from "./more-parser.js";
it("parses distinct meeting rows, noon/midnight and unknown times conservatively", () => {
  expect(parseClock("12:05p")).toBe(725); expect(parseClock("12:00a")).toBe(0); expect(parseClock("13:00p")).toBeNull();
  const html = `<table class="classTable"><tr><td><span class="classAbbreviation">CS 1000:</span><span class="classDescription">Example</span></td></tr><tr class="odd classRow"><td id="classNumber_12" class="classSection" onclick="f({termCode: '1075'})">01</td><td class="classHours">3.0 hrs</td><td class="classType">Lecture</td><td class="classMeetingDays">MWF<br>TR</td><td class="classMeetingTimes">10:00a - 10:50a<br>12:00p - 12:50p</td><td class="classBuilding">Hall 1<br>Hall 2</td><td class="classInstructor">Example, Professor</td></tr></table>`;
  const sections = parseSectionResults(html); expect(sections).toHaveLength(1); expect(sections[0]!.meetings).toEqual([{ days: ["M", "W", "F"], start: 600, end: 650, location: "Hall 1" }, { days: ["T", "R"], start: 720, end: 770, location: "Hall 2" }]);
  const tba = parseSectionResults(html.replace('10:00a - 10:50a', 'TBA'))[0]!; expect(tba.timeUnknown).toBe(true); expect(tba.meetings).toHaveLength(1);
});
it("keeps official description and prerequisite text separate and never executes scripts", () => {
  const detail = parseCourseDetail('<h2>Course</h2><b>Requirement:</b> Prereq: CS 1101 or CS 1104.<h3>Description</h3>Introduction to concepts.<button>Close</button><script>throw new Error("not data")</script>');
  expect(detail.prerequisiteText).toBe('CS 1101 or CS 1104'); expect(detail.description).toBe('Introduction to concepts.'); expect(detail.text).not.toContain('throw');
});
it("never mismatches a course with another row's catalog identity", () => {
  const row = (number: string, id?: string) => `<tr class="classRow" ${id ? `onclick="showCourseDetail('${id}', '1')"` : ""}><td>CS</td><td>Computer Science</td><td>${number}</td><td>Example</td><td>Engineering</td><td>Fall</td></tr>`;
  const html = `<button onclick="showCourseDetail('999', '1')">Unrelated</button>${row("1000")}${row("2000", "123")}`;
  expect(parseCourseResults(html)).toEqual([{ id: "123", offerNumber: 1, course: "CS 2000", subject: "Computer Science", title: "Example", school: "Engineering", typicallyOffered: "Fall" }]);
});
it("resolves YES named detail helpers without relying on source order or executing scripts", () => {
  const helper = (suffix: number, id: string) => `<script>function showCourseDetail_${suffix}(courseKeyId, offerNumber, notificationString) { var notificationString = 'CS-2000'; YAHOO.mis.student.CourseDetailPanel.showCourseDetail('${id}', '1', notificationString); }</script>`;
  const html = `${helper(0, "999")}${helper(1, "123")}<tr class="classRow"><td onclick="showCourseDetail_1()">CS</td><td>Computer Science</td><td>2000</td><td>Example</td><td>Engineering</td><td>Fall</td></tr>`;
  expect(parseCourseResults(html)[0]?.id).toBe("123");
});
it("normalizes Th-style day notation to R", () => {
  const html = `<table class="classTable"><tr><td><span class="classAbbreviation">CS 1000:</span><span class="classDescription">Example</span></td></tr><tr class="odd classRow"><td id="classNumber_21" class="classSection" onclick="f({termCode: '1075'})">01</td><td class="classHours">3.0 hrs</td><td class="classType">Lecture</td><td class="classMeetingDays">TTh</td><td class="classMeetingTimes">10:00a - 10:50a</td><td class="classBuilding">Hall 1</td><td class="classInstructor">Example, Professor</td></tr></table>`;
  const sections = parseSectionResults(html);
  expect(sections).toHaveLength(1);
  expect(sections[0]!.meetings).toHaveLength(1);
  expect(sections[0]!.meetings[0]!.days).toEqual(["T", "R"]);
});
it("falls back to the first building when a later meeting has no matching location line", () => {
  const html = `<table class="classTable"><tr><td><span class="classAbbreviation">CS 1000:</span><span class="classDescription">Example</span></td></tr><tr class="odd classRow"><td id="classNumber_22" class="classSection" onclick="f({termCode: '1075'})">01</td><td class="classHours">3.0 hrs</td><td class="classType">Lecture</td><td class="classMeetingDays">MWF<br>TR</td><td class="classMeetingTimes">10:00a - 10:50a<br>12:00p - 12:50p</td><td class="classBuilding">Hall 1</td><td class="classInstructor">Example, Professor</td></tr></table>`;
  const sections = parseSectionResults(html);
  expect(sections[0]!.meetings).toHaveLength(2);
  expect(sections[0]!.meetings[1]!.location).not.toBe("");
  expect(sections[0]!.meetings[1]!.location).toBe(sections[0]!.meetings[0]!.location);
});
it("leaves a Staff instructor cell unchanged", () => {
  const html = `<table class="classTable"><tr><td><span class="classAbbreviation">CS 1000:</span><span class="classDescription">Example</span></td></tr><tr class="odd classRow"><td id="classNumber_23" class="classSection" onclick="f({termCode: '1075'})">01</td><td class="classHours">3.0 hrs</td><td class="classType">Lecture</td><td class="classMeetingDays">MWF</td><td class="classMeetingTimes">10:00a - 10:50a</td><td class="classBuilding">Hall 1</td><td class="classInstructor">Staff</td></tr></table>`;
  const sections = parseSectionResults(html);
  expect(sections[0]!.instructors).toEqual(["Staff"]);
});
it("reuses a single day line across multiple meeting times without throwing", () => {
  const html = `<table class="classTable"><tr><td><span class="classAbbreviation">CS 1000:</span><span class="classDescription">Example</span></td></tr><tr class="odd classRow"><td id="classNumber_24" class="classSection" onclick="f({termCode: '1075'})">01</td><td class="classHours">3.0 hrs</td><td class="classType">Lecture</td><td class="classMeetingDays">MWF</td><td class="classMeetingTimes">10:00a - 10:50a<br>12:00p - 12:50p</td><td class="classBuilding">Hall 1<br>Hall 2</td><td class="classInstructor">Example, Professor</td></tr></table>`;
  expect(() => parseSectionResults(html)).not.toThrow();
  const sections = parseSectionResults(html);
  expect(sections[0]!.meetings).toHaveLength(2);
  expect(sections[0]!.meetings[0]!.days).toEqual(["M", "W", "F"]);
  expect(sections[0]!.meetings[1]!.days).toEqual(sections[0]!.meetings[0]!.days);
});
