import { useEffect, useState } from "react";

type SetupStatus = { readyForAuth?: boolean; identityConfigured?: boolean; passkeyConfigured?: boolean; passkeyValid?: boolean; browserAvailable?: boolean; nextStep?: string; };
export type SetupCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Setup runs in one deterministic operation; the UI collects identity and consent, not login steps. */
export function SetupPanel({ call }: { call: SetupCall }) {
  const [status, setStatus] = useState<SetupStatus>();
  const [identity, setIdentity] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("Use your Vanderbilt email or VUnetID. Configure an optional password in your host's secret vault, never in chat.");

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); } catch (error) {
      setNotice(error instanceof Error ? error.message : "Setup failed. Check the reported prerequisite before retrying.");
    } finally { setBusy(false); }
  }
  const check = async () => {
    const result = await call("setup.status", {});
    setStatus(result);
    setNotice(String(result.nextStep || "Setup checked."));
  };
  useEffect(() => { void run(check); }, []);

  return <section aria-labelledby="setup-heading" className="rounded-xl border p-6 space-y-4">
    <div><h2 id="setup-heading" className="text-xl font-semibold">Connect Vanderbilt</h2>
      <p className="text-sm text-muted-foreground">One setup call. A dedicated passkey keeps your agent connected.</p></div>
    <div className="flex flex-wrap gap-2">
      <button className="rounded-md border px-3 py-2" disabled={busy} onClick={() => run(check)}>Check setup</button>
      <span role="status" className="self-center text-sm">{connected ? "Connection verified" : status?.readyForAuth ? "Configured · connection not yet checked" : status ? "Setup needed" : "Not checked"}</span>
    </div>
    {!status?.identityConfigured && <div className="space-y-2">
      <label className="block text-sm" htmlFor="vu-identity">Vanderbilt email or VUnetID</label>
      <input id="vu-identity" autoComplete="username" className="w-full rounded-md border bg-background px-3 py-2" value={identity} onChange={(event) => setIdentity(event.target.value)} />
      <button className="rounded-md border px-3 py-2" disabled={busy || !identity.trim()} onClick={() => run(async () => {
        await call("setup.identity", identity.includes("@") ? { email: identity.trim() } : { vunetId: identity.trim() });
        await check();
      })}>Save account</button>
    </div>}
    <p className="text-sm">Setup reuses your signed-in browser first. Otherwise it uses the identity and optional password from your host vault. If OneVU requires verification, approve it on your phone or follow the returned instruction. No passwords or codes belong in chat.</p>
    {status?.passkeyConfigured && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={recovery} onChange={(event) => setRecovery(event.target.checked)} />
      Recovery: OneVU rejected this toolkit's key. Preserve it as a vault backup and issue a replacement.</label>}
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
      I authorize connecting this account and adding a toolkit passkey if needed.</label>
    <button className="rounded-md bg-primary text-primary-foreground px-3 py-2" disabled={busy || !confirmed || !status?.identityConfigured} onClick={() => run(async () => {
      setConnected(false);
      const result = await call("setup.run", { confirm: true, recovery, allowInteractiveVerification: true });
      setConfirmed(false);
      setRecovery(false);
      await check();
      setConnected(result.status === "ready");
      setNotice(result.status === "ready"
        ? "Vanderbilt setup completed and the connection was verified. Your toolkit passkey is stored securely."
        : String(result.nextStep || "Setup returned without verified completion. Check its result before retrying."));
    })}>{recovery ? "Recover connection" : "Connect account"}</button>
    <details className="text-sm"><summary>Manual sign-in fallback</summary>
      <p className="my-2">If no password is configured, open the toolkit's OneVU tab and sign in yourself. Then run Connect account again. It will reuse that session.</p>
      <button className="rounded-md border px-3 py-2" disabled={busy} onClick={() => run(async () => {
        const result = await call("setup.prepare", { keepTab: true, recovery });
        setNotice(String(result.nextStep || "Continue in the returned OneVU browser tab, then run Connect account."));
      })}>Open OneVU sign-in</button>
    </details>
    <p className="text-sm" aria-live="polite">{busy ? "Connecting… OneVU may ask for verification on your phone." : notice}</p>
  </section>;
}
