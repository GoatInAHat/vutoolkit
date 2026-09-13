# vutoolkit — original brief

Captured verbatim from Bennett, 2026-09-13. Auth specifics and secrets are managed via the OpenClaw secret vault; nothing secret belongs in this repo.

---

I'd like to create a universal toolkit for managing your life as a student at Vanderbilt using AI agents with toolfactory.

First, and most universal: auth method. User-specific auth information vutoolkit may need:

Non-secret (needs at least one, both for completeness)
- VUnetID
- Email

Secret
- Passkey (required for auth, requires setup flow to issue a passkey for the tool)
- Password (optional; some platforms default to using your password if they don't support OneVU SSO. CLI and core logic don't need this — supporting such platforms is out of scope — but an agent logging into one of these platforms may find this useful)

Vanderbilt has an SSO system called OneVU. They partner with Okta for 2FA, which would usually make programmatic login very difficult, but passkeys can be used instead of Okta.

## Core functionality

The core logic is intentionally minimal. It handles authentication, and returns valid Vanderbilt SSO and Microsoft sessions. These sessions can be used in any browser, or directly with the APIs of whatever service the agent is trying to use (everything that authenticates with either Vanderbilt SSO or Microsoft sessions). All surfaces (agent plugin, MCP, CLI) provide wrappers around these services that inject the valid session auth, or generate a new one with the configured secrets, cache it, and inject it if there isn't one already cached. We won't attempt to provide friendly custom tools for everything, because API routes can change and we want vutoolkit to remain compatible with all services unless the core authentication logic for OneVU or Microsoft changes.

The exception is specific tools: programs that use data from Vanderbilt's systems about the student to provide specific new functionality that Vanderbilt's systems don't offer.

### Tool 1: what-if grades calculator

The core vutoolkit library, CLI, and MCP server should provide an interface to this. The tool grabs the student's academic record from yes.vanderbilt.edu (grades from all past courses, plus currently enrolled courses with unposted grades), accepts JSON of what-if grades the student expects in their current classes, and reports what their semester and cumulative GPA will be. A great online (auth-required) test: if the calculated cumulative GPA and per-semester GPAs match the numbers Vanderbilt calculated and posted on the academic record, we can trust the what-if grades.

### UI: browser extension for YES

Example of a Chrome extension that interfaces with YES — needs rewriting; vutoolkit should replace it completely, so we need 100% feature coverage of what it does, tested and verified:
- https://chromewebstore.google.com/detail/vandy-scheduler/ofkamcklfkpakjddlappmemldnnapina
- https://github.com/quinton22/VandyScheduler

If we're building this right, the core lib gains a global way of fetching the academic record and related information. The MCP server and CLI can be given specific tools related to this information, but we don't want to prematurely build things that break if API routes change. Even without those specific tools, any agent can still get all this information by using the API directly.

### Tool 2: degree planner

More complicated: extensive fetching from YES. Formatting of prerequisites in course descriptions is inconsistent, but there might be a durable API representation (YES detects missing prerequisites at registration and returns a structured error). Goal: make degree/prerequisite planning tractable. The degree audit and class planner features of YES are very useful — take maximum advantage of them via the API instead of hand-rolling, but the web UI is clunky. Example problem: how many different "or" options prerequisites can have.

Show a directed-graph representation of a student's path to their degree, with all options mapped out and ranking of optimality shown via color (d3.js on the web UI). Classes already in the student's planner can be factored in even if not strictly required. Rate My Professors data can be aggregated per professor/class as node metadata, along with official description, time, location, schedule, etc. The graph can be constructed deterministically with all possible paths ranked via edge/path-segment/path weights (exact graph theory is an R&D task), and becomes far more useful when an agent knows the student's goals, research interests, professors they want to work with (via email access, session logs, Brightspace access, and other information streams).

All the machinery that enables this also becomes agent-facing tools, with minimum viable additional maintenance surface.

## Development

Auth information for agentic use already exists (the old Railway OpenClaw deployment logs into Bennett's Vanderbilt account and has sticks-and-duct-tape scripts for some of this). Build against the real authenticated account, read-only. All operations of the two named tools are read-only (update the Chrome extension to modify cart, not actual enrollment), though agents will have full API/browser access with those credentials.

Build order:
1. Working automated SSO login
2. SSO login → Microsoft (Graph) login
3. Both tools
4. Setup flow: from user providing everything except the passkey to issuing the passkey and saving it securely — as user-friendly, automatic, and reliable as possible

Build using toolfactory (github.com/GoatInAHat/toolfactory); improve toolfactory where needed. Serve useful UI/widgets from within the OpenClaw Control UI (coordinate toolfactory updates with the toolfactory session; GSD integration updates with the session that manages it).
