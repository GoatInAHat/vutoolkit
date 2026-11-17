// Diagnostic for VUTOOLKIT_DEBUG_WEBAUTHN=1: checks whether Chromium keeps a CDP virtual
// authenticator across navigations, with no sign-in, push or enrollment. Logs only outcomes.
const root = new URL("../../", import.meta.url);
const { withCdpTab, attachTargetSession } = await import(new URL("dist/sso/cdp-driver.js", root).href);
const cdp = process.env.VUTOOLKIT_CDP_URL ?? "http://127.0.0.1:9222";
const log = (m) => console.error(`[vutoolkit] webauthn-probe: ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPTIONS = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };

export async function webauthnProbe() {
  for (let i = 0; i < 30; i++) { try { const r = await fetch(new URL("/json/version", cdp)); if (r.ok) { log(`browser ${(await r.json()).Browser}`); break; } } catch {} await sleep(2000); }
  const steps = [
    ["onevu settings", "https://onevu.vanderbilt.edu/account-settings/security"],
    ["onevu home", "https://onevu.vanderbilt.edu/app/UserHome"],
    ["example.com", "https://example.com/"],
    ["webauthn.io", "https://webauthn.io/"],
  ];
  try {
    await withCdpTab(cdp, "about:blank", async (tab) => {
      const check = async (send, id, label) => {
        try { const r = await send("WebAuthn.getCredentials", { authenticatorId: id }); log(`${label}: ok (${r.credentials.length} credentials)`); return true; }
        catch (e) { log(`${label}: ${e.message}`); return false; }
      };
      await tab.send("WebAuthn.enable");
      let id = (await tab.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS })).authenticatorId;
      await check(tab.send, id, "about:blank");
      for (const [label, url] of steps) {
        await tab.send("Page.navigate", { url });
        await sleep(8000);
        const href = await tab.evaluate("location.origin + location.pathname").catch((e) => "?" + e.message);
        const targets = await fetch(new URL("/json/list", cdp)).then((r) => r.json()).then((l) => l.filter((t) => t.type === "page").map((t) => `${t.id.slice(0, 6)}${t.id === tab.tabId ? "*" : ""}`).join(",")).catch(() => "?");
        const kept = await check(tab.send, id, `after ${label} (${href}; targets ${targets}), same session`);
        if (!kept) {
          try { await tab.send("WebAuthn.enable"); id = (await tab.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS })).authenticatorId; await check(tab.send, id, `  re-enabled on same session`); }
          catch (e) { log(`  re-enable on same session failed: ${e.message}`); }
          try {
            const s = await attachTargetSession(cdp, tab.tabId);
            await s.send("WebAuthn.enable"); const fid = (await s.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS })).authenticatorId;
            await check(s.send, fid, "  fresh session");
            await sleep(2000); await check(s.send, fid, "  fresh session after 2s");
            s.close();
          } catch (e) { log(`  fresh session failed: ${e.message}`); }
          try { await tab.send("WebAuthn.enable"); id = (await tab.send("WebAuthn.addVirtualAuthenticator", { options: OPTIONS })).authenticatorId; } catch {}
        }
      }
    });
  } catch (e) { log(`aborted: ${e.message}`); }
  log("done");
}
