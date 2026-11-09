# Authentication ownership and caller budgets

Ceremony-capable operations are listed in `src/sso/budget.ts`. They expose optional
integer `timeoutSeconds` (1–570). Pass `timeoutSeconds: 300` when a sign-in may be
needed. OpenClaw's Codex harness reads the argument before execution and allows
30 seconds beyond it (600 seconds maximum); the toolkit bounds the entire operation
by the requested time, not each retry separately. Omitting it preserves existing
behavior, including setup's existing defaults.

The wrapper uses AsyncLocalStorage to carry cancellation into internal ensures,
including YES, Graph, Brightspace and setup. The native adapter is intentionally
adopted from Tool Factory 0.4.6: that generator did not forward the tool execution
signal. It now derives all native schemas and descriptions from the core operations,
validates arguments and forwards `execution.signal`. New ceremony operations must
be added to `ceremonyTools` and the schema coverage test.

Refresh and ensure share ownership keyed by credential-store location and IdP.
The plugin has one configured store, so all its same-IdP calls share that flight.
Individual callers keep their own wait deadlines. Ownership ends only when the
actual work finishes, not when a waiter times out. A failed flight releases ownership.
When no callers remain, preparation/retries are cancelled at the next safe boundary.
One caller's abort does not cancel a surviving waiter. A concurrent cache-only ensure
cannot satisfy a forced refresh: a refresh starts a mint if the shared result was cache.
Different IdPs are independent; Microsoft federation re-enters the Vanderbilt flight.

Do not pass caller cancellation into an already-started assertion: a used passkey
counter must be durably written and read back before cancellation is honoured.
There are checks before starting ceremonies, before retries, and after persistence.
The vault write mechanism itself is unchanged. These locks are process-local, not a
cross-process lock for an external CLI racing the gateway.

Credential-free tests: `npm test -- --maxWorkers=1` and `npm run build` (tsc plus
package preparation). Native adapter tests: build the isolated core first, then
run `npm -C hosts/openclaw test -- --maxWorkers=1`. No live account is needed.
