/** Read-only Commodore Access inspection. Run with node --import tsx; never submits portal forms. */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runSsoCeremony } from '../src/sso/ceremony.ts';
import { augmentNoProxy, withCdpTab } from '../src/sso/cdp-driver.ts';

const origin = 'https://augusta.accessiblelearning.com';
const entry = origin + '/Vanderbilt/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const available = () => Number(readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/)[1]) * 1024;
const gib = () => +(available() / 2 ** 30).toFixed(3);
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const secret = name => execFileSync('openclaw', ['secrets', 'store', 'get', name, '--plain'], {
  encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

export function chromeEnvironment(env) {
  // Match stock OpenClaw browser launches: provider/Node proxy configuration is not Chrome configuration.
  const result = { ...env };
  for (const name of Object.keys(result)) {
    if (/^(https?|all|no)_proxy$/i.test(name) || /^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE)$/.test(name)) delete result[name];
  }
  return result;
}

export function readOnlyTestingUrl(href, base) {
  const url = new URL(href, base);
  if (url.origin !== origin || !['/Vanderbilt/dashboard/Testing.aspx', '/Vanderbilt/dashboard/ExamModify.aspx'].includes(url.pathname)) throw Error('NOT_A_TESTING_READ');
  if (url.pathname.endsWith('/ExamModify.aspx')) {
    if (!url.searchParams.get('ID') || !url.searchParams.get('EID') || [...url.searchParams.keys()].some(k => !['ID','EID'].includes(k))) throw Error('NOT_A_TESTING_READ');
  } else if (url.pathname.endsWith('/Testing.aspx')) {
    if (!['', 'Overview', 'Modify', 'List'].includes(url.searchParams.get('Step') ?? '') || [...url.searchParams.keys()].some(k => !['Step','ID','EID'].includes(k))) throw Error('NOT_A_TESTING_READ');
  } else throw Error('NOT_A_TESTING_READ');
  return url.href;
}

const snapshotExpression = `(() => ({
  path: location.origin + location.pathname, title: document.title, text: document.body.innerText,
  links: Array.from(document.querySelectorAll('a[href]')).map(a => ({text:a.innerText.trim(),href:a.getAttribute('href'),row:a.closest('tr')?.innerText})),
  tables: Array.from(document.querySelectorAll('table')).map(t => Array.from(t.rows).map(r => Array.from(r.cells).map(c => c.innerText.trim()))),
  controls: Array.from(document.querySelectorAll('button,input:not([type=hidden]):not([type=password]),select,textarea')).filter(e => e.getClientRects().length).map(e => ({tag:e.tagName,type:e.type,name:e.name,label:e.labels?.[0]?.innerText || e.textContent || e.value,disabled:e.disabled,options:e.tagName==='SELECT'?Array.from(e.options).map(o=>({text:o.text,value:o.value,selected:o.selected,disabled:o.disabled})):undefined}))
}))()`;

async function pageRead(cdp, url) {
  return withCdpTab(cdp, 'about:blank', async tab => {
    const navigation = await tab.send('Page.navigate', { url });
    if (navigation.errorText) throw Error(navigation.errorText);
    let previous = ''; let last;
    for (let i = 0; i < 30; i++) {
      await sleep(350);
      const state = await tab.evaluate('({url:location.href,ready:document.readyState,text:document.body?.innerText})').catch(() => null);
      last = state;
      if (!state?.url?.startsWith(origin + '/Vanderbilt/')) continue;
      if (state.ready === 'complete' && state.text && state.text === previous) return tab.evaluate(snapshotExpression);
      previous = state.text;
    }
    throw Error('PORTAL_READ_NOT_READY ' + (last?.url ? new URL(last.url).origin + new URL(last.url).pathname : 'unknown') + ' ' + last?.ready);
  });
}

async function inspect(out, number, inspectModify) {
  const receipt = { startedAt: new Date().toISOString(), coldProfile: true, toolkitVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, sourceCeremony: true, readOnly: true };
  let browser, profile, memoryGuard, deadline;
  const prefix = resolve(out, 'cold-' + number);
  try {
    const email = secret('VANDERBILT_EMAIL');
    const original = secret('VANDERBILT_PASSKEY');
    const passkey = JSON.parse(original);
    receipt.memoryStartGiB = gib();
    if (available() < 3 * 2 ** 30) throw Error('MEMORY_START_BELOW_3_GIB');
    const binary = process.env.VUTOOLKIT_CHROME_BINARY || '/usr/bin/google-chrome';
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).match(/\d+(?:\.\d+){3}/)?.[0];
    if (!version) throw Error('CHROME_VERSION_UNKNOWN');
    receipt.browserVersion = version;
    // Cirrus rejects HeadlessChrome's UA with 403. Only the compatibility UA differs; browser remains headless.
    const ua = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
    profile = mkdtempSync(resolve(out, '.cold-profile-'));
    browser = spawn(binary, ['--headless=new', '--user-agent=' + ua, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--renderer-process-limit=2', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { env: chromeEnvironment(process.env), stdio: 'ignore', detached: true });
    const stop = () => { try { process.kill(-browser.pid, 'SIGTERM'); } catch {} };
    const interrupted = () => { receipt.interrupted = true; stop(); };
    process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
    browser.once('exit', () => { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); });
    memoryGuard = setInterval(() => {
      receipt.memoryMinGiB = Math.min(receipt.memoryMinGiB ?? gib(), gib());
      if (available() < 2 * 2 ** 30) { receipt.memoryAborted = true; stop(); }
    }, 500);
    deadline = setTimeout(() => { receipt.deadlineAborted = true; stop(); }, 150_000);
    let cdp;
    for (let i = 0; i < 100; i++) {
      if (existsSync(profile + '/DevToolsActivePort')) { cdp = 'http://127.0.0.1:' + readFileSync(profile + '/DevToolsActivePort', 'utf8').split('\n')[0]; break; }
      await sleep(100);
    }
    if (!cdp) throw Error('BROWSER_UNAVAILABLE');
    const spLogin = await withCdpTab(cdp, 'about:blank', async tab => {
      const navigation = await tab.send('Page.navigate', { url: entry });
      if (navigation.errorText) throw Error(navigation.errorText);
      for (let i = 0; i < 60; i++) {
        await sleep(350);
        const url = await tab.evaluate('location.href').catch(() => null);
        if (typeof url === 'string' && new URL(url).hostname === 'onevu.vanderbilt.edu') return url;
      }
      throw Error('SP_LOGIN_DID_NOT_REACH_ONEVU');
    });
    receipt.spReachedOnevu = true;
    const minted = await runSsoCeremony({ cdpUrl: cdp, email, passkey, loginUrl: spLogin, successOrigin: origin, timeoutMs: 65_000, stepMs: 500 });
    receipt.ceremonyFinalPath = new URL(minted.finalUrl).origin + new URL(minted.finalUrl).pathname;
    receipt.signCountUsed = minted.signCountUsed;
    receipt.assertedSignCount = minted.assertedSignCount;
    if (!(minted.assertedSignCount > minted.signCountUsed)) throw Error('SP_ASSERTION_UNPROVEN');
    receipt.passkeyAssertionObserved = true;
    // Preserve every credential field; only save the actual monotonic signature counter, with compare/readback.
    if (secret('VANDERBILT_PASSKEY') !== original) throw Error('KEY_CHANGED_DURING_ASSERTION');
    const updated = JSON.stringify({ ...JSON.parse(original), signCount: minted.assertedSignCount });
    execFileSync('openclaw', ['secrets', 'store', 'set', 'VANDERBILT_PASSKEY', '--kind', 'env', '--value-file', '-'], { input: updated, stdio: ['pipe', 'ignore', 'ignore'], timeout: 25_000 });
    if (secret('VANDERBILT_PASSKEY') !== updated) throw Error('COUNTER_WRITE_NOT_VERIFIED');
    receipt.counterSaved = true;
    const dashboard = await pageRead(cdp, minted.finalUrl);
    const testing = dashboard.links.find(a => a.text === 'Alternative Testing');
    if (!testing) throw Error('ALTERNATIVE_TESTING_LINK_MISSING');
    const overviewUrl = new URL(readOnlyTestingUrl(testing.href, dashboard.path));
    overviewUrl.searchParams.set('Step', 'Overview');
    const upcoming = await pageRead(cdp, overviewUrl.href);
    save(prefix + '-upcoming.json', { capturedAt: new Date().toISOString(), ...upcoming });
    if (!/UPCOMING EXAMS SCHEDULED/i.test(upcoming.text)) throw Error('UPCOMING_EXAMS_NOT_AUTHENTICATED');
    receipt.hasUpcoming = true;
    receipt.tables = upcoming.tables.length;
    const modify = [...new Set(upcoming.links.filter(a => a.text === 'View' && /ExamModify\.aspx\?/i.test(a.href) || /[?&]Step=Modify(?:&|$)/i.test(a.href)).map(a => readOnlyTestingUrl(a.href, overviewUrl.href)))];
    receipt.modifyLinks = modify.length;
    if (inspectModify && upcoming.links.some(a => a.text === 'View') && !modify.length) throw Error('MODIFY_LINKS_CHANGED');
    if (inspectModify) {
      for (let i = 0; i < modify.length; i++) {
        const detail = await pageRead(cdp, modify[i]);
        save(prefix + '-modify-' + (i + 1) + '.json', { capturedAt: new Date().toISOString(), request: upcoming.links.find(a => { try { return new URL(a.href, overviewUrl.href).href === modify[i]; } catch { return false; } })?.row, ...detail });
      }
    }
    receipt.ok = true;
  } catch (error) {
    receipt.ok = false; receipt.code = error.code ?? null; receipt.message = String(error.message).slice(0, 400);
  } finally {
    clearTimeout(deadline);
    if (browser?.pid) {
      try { process.kill(-browser.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 20; i++) { try { process.kill(-browser.pid, 0); } catch { break; } await sleep(100); }
      try { process.kill(-browser.pid, 'SIGKILL'); } catch {}
      await sleep(100);
      try { process.kill(browser.pid, 0); receipt.browserClosed = false; } catch { receipt.browserClosed = true; }
    }
    clearInterval(memoryGuard);
    if (profile) rmSync(profile, { recursive: true, force: true });
    receipt.finishedAt = new Date().toISOString();
    save(prefix + '-receipt.json', receipt);
  }
  return receipt;
}

if (import.meta.main) {
  augmentNoProxy();
  const args = process.argv.slice(2);
  const out = resolve(args[args.indexOf('--out') + 1] || '.');
  if (!args.includes('--out')) throw Error('Usage: node --import tsx scripts/commodore-access.mjs --out PRIVATE_EVIDENCE_DIR [--repeat 2] [--inspect-modify]');
  const repeat = args.includes('--repeat') ? Number(args[args.indexOf('--repeat') + 1]) : 1;
  if (![1, 2].includes(repeat)) throw Error('repeat must be 1 or 2');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const receipts = [];
  for (let i = 1; i <= repeat; i++) {
    const receipt = await inspect(out, i, args.includes('--inspect-modify'));
    receipts.push(receipt); console.log(JSON.stringify(receipt));
    if (!receipt.ok || receipt.browserClosed === false) { process.exitCode = 1; break; }
  }
  save(resolve(out, 'receipts.json'), receipts);
}
