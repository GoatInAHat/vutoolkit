/**
 * The canonical synthetic transcript: one source of truth for the golden tests, the
 * gpa.verify default, and the what-if demo. Live anchors replace this only via explicit
 * fixtures captured against the real academic record (gated on credentials).
 */
import type { Transcript } from "./engine.js";

export const SYNTHETIC_TRANSCRIPT: Transcript = {
  terms: [
    {
      term: "2026.FALL",
      postedGpa: 3.42,
      courses: [
        { course: "MATH 1200", credits: 3, grade: "A" },
        { course: "CS 1101", credits: 4, grade: "B+" },
        { course: "ENGL 1200", credits: 3, grade: "B" },
      ],
    },
    {
      term: "2027.SPRING",
      postedGpa: 2.93,
      courses: [
        { course: "CS 2201", credits: 3, grade: "A-" },
        { course: "MATH 2300", credits: 3, grade: "B" },
        { course: "PHYS 1601", credits: 4, grade: "C+" },
        { course: "ECON 1010", credits: 3, grade: "W" },
        { course: "MUSL 1000", credits: 2, grade: "P" },
        { course: "HIST 1350", credits: 3 },
      ],
    },
  ],
};
