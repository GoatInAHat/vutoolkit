import { describe, expect, it } from "vitest";
import {
  YesWriteBlockedError,
  assertSafe,
  classify,
  planWrite,
} from "./guard.js";

describe("yes write guard", () => {
  it("lets non-mutating reads through", () => {
    expect(classify("https://yes.vanderbilt.edu/some/deep/api", "GET")).toBe("read");
    expect(() => assertSafe("https://yes.vanderbilt.edu/more/SeaWes", "GET")).not.toThrow();
  });

  it("blocks enrollment and known cart/planner actions even when they use GET", () => {
    expect(classify("https://yes.vanderbilt.edu/ProReg/enroll", "GET")).toBe("enrollment");
    for (const route of ["StudentClassExecute!add", "StudentClassExecute!remove", "PlannedCourseJson!save", "PlannedCourse!remove"]) {
      expect(() => assertSafe(`https://more.app.vanderbilt.edu/more/${route}.action`, "GET")).toThrow(YesWriteBlockedError);
    }
  });

  it("does not let percent-encoding bypass mutation guards", () => {
    expect(classify("https://yes.vanderbilt.edu/%65nroll", "GET")).toBe("enrollment");
    expect(classify("https://more.app.vanderbilt.edu/more/StudentClassExecute%21add.action", "GET")).toBe("blocked");
  });

  it("hard-blocks enrollment-shaped mutations, allowlist or not", () => {
    expect(classify("https://yes.vanderbilt.edu/ProReg/enroll", "POST")).toBe("enrollment");
    expect(() => assertSafe("https://yes.vanderbilt.edu/register/submit", "POST")).toThrow(
      YesWriteBlockedError,
    );
    // even a hypothetical future allowlist entry naming an enrollment route is refused
    expect(() => assertSafe("https://yes.vanderbilt.edu/enroll-cart", "PUT")).toThrow(
      /enrollment-shaped/,
    );
  });

  it("default-denies mutations that are not on the cart allowlist", () => {
    expect(classify("https://yes.vanderbilt.edu/api/cart", "POST")).toBe("blocked");
    expect(() => assertSafe("https://yes.vanderbilt.edu/api/cart", "POST")).toThrow(/default-deny/);
  });

  it("dry-run plans never execute and carry their classification", () => {
    const plan = planWrite({ url: "https://yes.vanderbilt.edu/api/cart", method: "post", label: "add MATH 1200" });
    expect(plan.executable).toBe(false);
    expect(plan.classification).toBe("blocked");
    expect(plan.method).toBe("POST");
  });
});
