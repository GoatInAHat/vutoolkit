import { useState } from "react";

type SetupStatus = { readyForAuth?: boolean; identityConfigured?: boolean; passkeyConfigured?: boolean; passkeyValid?: boolean; browserAvailable?: boolean; nextStep?: string; };
export type SetupCall = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Author-owned setup UI; the generated operation page can render this beside its tool forms. */
export function SetupPanel({ call }: { call: SetupCall }) {
  const [status, setStatus] = useState<SetupStatus>();
  const [identity, setIdentity] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Use your Vanderbilt email or VUnetID. Passwords and passkeys never go in this form.");

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); } catch { setNotice("Setup could not complete. Your existing credentials were not replaced. Check the operation result or try checking setup again."); }
    finally { setBusy(false); }
  }
  const check = async () => {
    const result = await call("setup.status", {});
    setStatus(result);
    setNotice(String(result.nextStep || "Setup checked."));
  };

  return <section aria-labelledby="setup-heading" className="rounded-xl border p-6 space-y-4">
    <div><h2 id="setup-heading" className="text-xl font-semibold">Connect Vanderbilt</h2>
      <p className="text-sm text-muted-foreground">Your account, secured by a dedicated toolkit passkey.</p></div>
    <div className="flex flex-wrap gap-2">
      <button className="rounded-md border px-3 py-2" disabled={busy} onClick={() => run(check)}>Check setup</button>
      <span role="status" className="self-center text-sm">{status?.readyForAuth ? "Configured · live sign-in not yet checked" : status ? "Setup needed" : "Not checked"}</span>
    </div>
    {!status?.passkeyConfigured && <div className="space-y-2">
      <label className="block text-sm" htmlFor="vu-identity">Vanderbilt email or VUnetID</label>
      <input id="vu-identity" autoComplete="username" className="w-full rounded-md border bg-background px-3 py-2" value={identity} onChange={(event) => setIdentity(event.target.value)} />
      <button className="rounded-md border px-3 py-2" disabled={busy || !identity.trim()} onClick={() => run(async () => {
        await call("setup.identity", identity.includes("@") ? { email: identity.trim() } : { vunetId: identity.trim() });
        await check();
      })}>Save account</button>
    </div>}
    <button className="rounded-md border px-3 py-2" disabled={busy} onClick={() => run(async () => {
      const result = await call("setup.prepare", { keepTab: true });
      setNotice(String(result.nextStep || "Continue in the managed OneVU browser tab."));
    })}>Prepare OneVU sign-in</button>
    {status && !status.passkeyConfigured && <div className="space-y-3">
      <p className="text-sm">Sign in once in the managed browser using your usual Vanderbilt sign-in method. Then add a passkey for this toolkit. Existing account passkeys are kept.</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        I want to add a toolkit passkey to my Vanderbilt account.</label>
      <button className="rounded-md bg-primary text-primary-foreground px-3 py-2" disabled={busy || !confirmed || !status.identityConfigured} onClick={() => run(async () => {
        const result = await call("setup.enroll", { confirm: true });
        setConfirmed(false);
        await check();
        setNotice(result.serverConfirmed === true ? "The new toolkit passkey is saved in your host vault and confirmed by OneVU." : "The key is saved in your host vault, but OneVU confirmation is still pending. Check the managed browser before proceeding.");
      })}>Create toolkit passkey</button>
    </div>}
    <p className="text-sm" aria-live="polite">{busy ? "Working…" : notice}</p>
  </section>;
}
