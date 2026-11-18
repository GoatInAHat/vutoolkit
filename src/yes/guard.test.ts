import { describe, expect, it } from "vitest";
import { YesWriteBlockedError, assertYesReadOnly, classify, isYesHost } from "./guard.js";

describe("yes write guard", () => {
  it("knows the YES hosts", () => {
    expect(isYesHost("yes.vanderbilt.edu")).toBe(true);
    expect(isYesHost("more.app.vanderbilt.edu")).toBe(true);
    expect(isYesHost("brightspace.vanderbilt.edu")).toBe(false);
  });

  it("lets reads through", () => {
    expect(classify("https://yes.vanderbilt.edu/some/deep/api", "GET")).toBe("read");
    expect(() => assertYesReadOnly("https://more.app.vanderbilt.edu/more/SeaWes", "GET")).not.toThrow();
  });

  it("refuses enrollment and the cart and planner actions, even over GET", () => {
    expect(classify("https://yes.vanderbilt.edu/ProReg/enroll", "GET")).toBe("enrollment");
    for (const route of ["StudentClassExecute!add", "StudentClassExecute!remove", "PlannedCourseJson!save", "PlannedCourse!remove"]) {
      expect(() => assertYesReadOnly(`https://more.app.vanderbilt.edu/more/${route}.action`, "GET")).toThrow(YesWriteBlockedError);
    }
    expect(() => assertYesReadOnly("https://yes.vanderbilt.edu/register/submit", "POST")).toThrow(/enrollment-shaped/);
    expect(() => assertYesReadOnly("https://yes.vanderbilt.edu/api/cart", "POST")).toThrow(/read-only/);
  });

  it("does not let percent-encoding bypass it", () => {
    expect(classify("https://yes.vanderbilt.edu/%65nroll", "GET")).toBe("enrollment");
    expect(classify("https://more.app.vanderbilt.edu/more/StudentClassExecute%21add.action", "GET")).toBe("blocked");
  });

  it("leaves other hosts alone", () => {
    expect(() => assertYesReadOnly("https://brightspace.vanderbilt.edu/d2l/api/lp/1.46/enrollments/myenrollments/", "GET")).not.toThrow();
    expect(() => assertYesReadOnly("https://outlook.office.com/owa/service.svc", "POST")).not.toThrow();
  });
});
