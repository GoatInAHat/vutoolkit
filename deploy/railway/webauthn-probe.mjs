// Diagnostic for VUTOOLKIT_DEBUG_WEBAUTHN=1: checks, with no sign-in, push or enrollment, how
// Chromium's CDP virtual authenticator behaves on OneVU pages, and whether re-arming it after each
// navigation keeps a credential usable there. Credentials made here stay in the local authenticator
// and are never sent to OneVU. Logs outcomes only, never key material.
const root = new URL("../../", import.meta.url);
const { withCdpTab } = await import(new URL("dist/sso/cdp-driver.js", root).href);
const cdp = process.env.VUTOOLKIT_CDP_URL ?? "http://127.0.0.1:9222";
const log = (m) => console.error(`[vutoolkit] webauthn-probe: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPTIONS = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };

const CREATE = `(async () => { try {
  const c = await navigator.credentials.create({ publicKey: { rp: { id: 'onevu.vanderbilt.edu', name: 'probe' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'probe', displayName: 'probe' },
    challenge: crypto.getRandomValues(new Uint8Array(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 6000 } });
  return 'created ' + c.type; } catch (e) { return 'create failed: ' + e.name + ': ' + e.message; } })()`;
const GET = (id) => `(async () => { try {
  const c = await navigator.credentials.get({ publicKey: { rpId: 'onevu.vanderbilt.edu', challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentials: [{ type: 'public-key', id: Uint8Array.from(atob(${JSON.stringify(id)}), (x) => x.charCodeAt(0)) }], userVerification: 'required', timeout: 8000 } });
  return 'asserted ' + c.type; } catch (e) { return 'get failed: ' + e.name + ': ' + e.message; } })()`;

export async function webauthnProbe() {
  for (let i = 0; i < 30; i++) { try { const r = await fetch(new URL("/json/version", cdp)); if (r.ok) { log(`browser ${(await r.json()).Browser}`); break; } } catch {} await sleep(2000); }
  try {
    await withCdpTab(cdp, "about:blank", async (tab) => {
      let id;
      let saved;
      let arms = 0;
      const events = [];
      const arm = async (why) => {
        try {
          await tab.send("WebAuthn.enable", { enableUI: false });
          id = (await tab.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS })).authenticatorId;
          if (saved) await tab.send("WebAuthn.addCredential", { authenticatorId: id, credential: saved });
          arms++;
          events.push(`armed(${why})`);
        } catch (e) { events.push(`arm(${why}) failed: ${e.message}`); }
      };
      const t0 = Date.now();
      let trace = [];
      tab.onEvent((method, params) => {
        if (!method.startsWith("Network.") || method === "Network.responseReceived") trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${method}${params.frame?.parentId || params.frameId && params.frameId !== tab.tabId ? "(sub)" : ""}${method === "Page.lifecycleEvent" ? ":" + params.name : ""}`);
        if (trace.length > 400) trace = trace.slice(-200);
      });
      let watchdog = 0, lost = 0;
      let busy = false;
      const timer = setInterval(async () => {
        if (!id || busy) return;
        busy = true;
        try { await tab.send("WebAuthn.getCredentials", { authenticatorId: id }); }
        catch {
          lost++;
          trace.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ** environment lost`);
          try { await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id }); } catch {}
          await arm("watchdog"); watchdog++;
        } finally { busy = false; }
      }, 200);
      tab.onEvent((method, params) => {
        if (method === "Page.frameNavigated" && !params.frame?.parentId) {
          let where = "?"; try { const u = new URL(params.frame.url); where = u.origin === "null" ? u.href : u.host; } catch {}
          events.push(`navigated ${where}`);
          // The environment usually survives the commit itself; the watchdog re-arms when it drops.
        }
        if (method === "WebAuthn.credentialAdded") { saved = { ...params.credential }; events.push("credentialAdded"); }
        if (method === "WebAuthn.credentialAsserted") { if (saved) saved.signCount = params.credential.signCount; events.push(`credentialAsserted signCount=${params.credential.signCount}`); }
      });
      const responses = [];
      tab.onEvent((method, params) => {
        if (method !== "Network.responseReceived" || params.type !== "Document") return;
        const h = Object.fromEntries(Object.entries(params.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        let host = "?"; try { host = new URL(params.response.url).host; } catch {}
        responses.push(`${host} ${params.response.status} coop=${h["cross-origin-opener-policy"] ?? "-"} coep=${h["cross-origin-embedder-policy"] ?? "-"} oac=${h["origin-agent-cluster"] ?? "-"} pp=${String(h["permissions-policy"] ?? "-").slice(0, 120)}`);
      });
      await tab.send("Page.enable");
      await tab.send("Network.enable");
      await tab.send("Page.setLifecycleEventsEnabled", { enabled: true });
      await tab.send("Runtime.enable");
      await tab.send("Inspector.enable").catch(() => {});
      await arm("start");
      const check = async (label) => {
        let creds = "?";
        try { creds = `${(await tab.send("WebAuthn.getCredentials", { authenticatorId: id })).credentials.length} credentials`; } catch (e) { creds = e.message; }
        log(`${label}: ${creds} | events: ${events.splice(0).join(", ") || "none"} | docs: ${responses.splice(0).join(" ; ") || "none"}`);
        log(`${label} trace: ${trace.filter((t) => !/Page\.(frameStartedLoading|frameStoppedLoading)\(sub\)/.test(t)).slice(-45).join(" / ")}`);
        trace = [];
      };
      const go = async (label, url) => { await tab.send("Page.navigate", { url }); await sleep(8000); await check(label); };
      await go("onevu settings", "https://onevu.vanderbilt.edu/account-settings/security");
      log(`create on settings: ${await tab.evaluate(CREATE).catch((e) => e.message)}`);
      await sleep(500);
      await check("after create");
      await go("onevu home", "https://onevu.vanderbilt.edu/app/UserHome");
      if (saved) log(`get on home: ${await tab.evaluate(GET(saved.credentialId)).catch((e) => e.message)}`);
      await sleep(500);
      await check("after get");
      await go("example.com", "https://example.com/");
      log(`re-arms: ${arms}; environment lost ${lost} times, watchdog re-armed ${watchdog}`);
      clearInterval(timer);
      if (id) await tab.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id }).catch(() => {});
    });
  } catch (e) { log(`aborted: ${e.message}`); }
  log("done");
}
