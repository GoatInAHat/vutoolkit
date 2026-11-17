import { describe, expect, it } from "vitest";
import { searchProfessors } from "./professors.js";
const edge = (firstName: string, lastName: string) => ({ node: { id: `${firstName}-${lastName}`, legacyId: `${firstName}-${lastName}`, firstName, lastName, avgRating: 4, numRatings: 10, avgDifficulty: 2, wouldTakeAgainPercent: 80, department: "CS" } });
const okFetch = (body: unknown): typeof fetch => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
describe("searchProfessors", () => {
  it("throws with the HTTP status when the request fails", async () => {
    const failFetch = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(searchProfessors("Jane Doe", failFetch)).rejects.toThrow(/Rate My Professors is unavailable/);
    await expect(searchProfessors("Jane Doe", failFetch)).rejects.toThrow(/500/);
  });
  it("throws a schema-changed error when the response carries a GraphQL errors array", async () => {
    const fetchImpl = okFetch({ errors: [{ message: "bad query" }] });
    await expect(searchProfessors("Jane Doe", fetchImpl)).rejects.toThrow("Rate My Professors response schema changed");
  });
  it("throws a schema-changed error when the edges path is missing", async () => {
    const fetchImpl = okFetch({ data: {} });
    await expect(searchProfessors("Jane Doe", fetchImpl)).rejects.toThrow("Rate My Professors response schema changed");
  });
  it("flags only the edge whose normalized name exactly matches the query", async () => {
    const fetchImpl = okFetch({ data: { newSearch: { teachers: { edges: [edge("Jane", "Doe"), edge("John", "Smith")] } } } });
    const result = await searchProfessors("Jane Doe", fetchImpl);
    expect(result.professors).toHaveLength(2);
    expect(result.professors.find((p) => p.name === "Jane Doe")!.exactNameMatch).toBe(true);
    expect(result.professors.find((p) => p.name === "John Smith")!.exactNameMatch).toBe(false);
  });
  it("marks every candidate as non-exact and keeps them all when no edge matches (namesake ambiguity)", async () => {
    const fetchImpl = okFetch({ data: { newSearch: { teachers: { edges: [edge("Jon", "Smith"), edge("Johnny", "Smith")] } } } });
    const result = await searchProfessors("John Smith", fetchImpl);
    expect(result.professors).toHaveLength(2);
    expect(result.professors.every((p) => p.exactNameMatch === false)).toBe(true);
  });
  it("reverses a comma-formatted query name before matching", async () => {
    const fetchImpl = okFetch({ data: { newSearch: { teachers: { edges: [edge("Professor", "Example")] } } } });
    const result = await searchProfessors("Example, Professor", fetchImpl);
    expect(result.professors[0]!.exactNameMatch).toBe(true);
  });
});
