/** Public Rate My Professors metadata. Return candidates; never silently conflate namesakes. */
export async function searchProfessors(name: string, fetchImpl: typeof fetch = fetch) {
  const text = name.includes(",") ? name.split(",").reverse().join(" ").trim() : name.trim();
  const query = `query TeacherSearch($text: String!) { newSearch { teachers(first: 10, query: {text: $text, schoolID: "U2Nob29sLTQwMDI="}) { edges { node { id legacyId firstName lastName avgRating numRatings avgDifficulty wouldTakeAgainPercent department } } } } }`;
  const response = await fetchImpl("https://www.ratemyprofessors.com/graphql", { method: "POST", headers: { "content-type": "application/json", authorization: "Basic dGVzdDp0ZXN0" }, body: JSON.stringify({ query, variables: { text } }), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Rate My Professors is unavailable (HTTP ${response.status})`);
  const data = await response.json() as { errors?: unknown[]; data?: { newSearch?: { teachers?: { edges?: { node: Record<string, unknown> }[] } } } };
  if (data.errors || !Array.isArray(data.data?.newSearch?.teachers?.edges)) throw new Error("Rate My Professors response schema changed");
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
  return { professors: data.data.newSearch.teachers.edges.map(({ node }) => ({
    id: String(node.legacyId), name: `${node.firstName} ${node.lastName}`, department: String(node.department ?? ""),
    rating: Number(node.avgRating), count: Number(node.numRatings), difficulty: Number(node.avgDifficulty), wouldTakeAgainPercent: Number(node.wouldTakeAgainPercent),
    url: `https://www.ratemyprofessors.com/professor/${node.legacyId}`,
    exactNameMatch: normalize(`${node.firstName} ${node.lastName}`) === normalize(text),
  })), source: "Rate My Professors", fetchedAt: new Date().toISOString(), note: "Student-contributed ratings; choose the correct professor when names are ambiguous. No Vanderbilt credentials are sent." };
}
