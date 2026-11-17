/**
 * Playwright proof of the fresh-install onboarding flow (docs/ACCEPTANCE.md "S05 onboarding
 * coverage"): a just-loaded temporary extension fires `runtime.onInstalled` with reason
 * "install", which background.ts's `handleInstall` turns into a default-to-setup popup/options
 * page; App.tsx routes accordingly and SetupPanel's `onConnected` callback persists the flag.
 *
 * Run `npm --prefix hosts/browser run build` first; this loads `.output/chrome-mv3`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../web/node_modules/playwright/index.mjs';

const extension = join(process.cwd(), 'hosts/browser/.output/chrome-mv3');
const TOKEN = 'onboarding-smoke-token';

let identityConfigured = false;
const kernel = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    const rpc = JSON.parse(body || '{}');
    const name = rpc.params?.name;
    let result;
    if (name === 'setup.status') {
      result = identityConfigured
        ? { identityConfigured: true, readyForAuth: true }
        : { identityConfigured: false, readyForAuth: false };
    } else if (name === 'setup.identity') {
      identityConfigured = true;
      result = { ok: true };
    } else if (name === 'setup.run') {
      result = { status: 'ready' };
    } else {
      result = {};
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: result } }));
  });
});
await new Promise((resolve) => kernel.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${kernel.address().port}/mcp`;

const profile = mkdtempSync(join(tmpdir(), 'vutoolkit-onboarding-'));
// `channel: "chromium"` is the full build; the headless shell cannot side-load an extension.
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const failures = [];
context.on('weberror', (error) => failures.push(error.error().message));

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;

  // Step 1: a fresh install defaults the popup straight to setup, with the "open full page" hint.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#setup-heading').waitFor();
  await popup.getByText('Continue in the full page', { exact: false }).waitFor();
  console.log('PASS fresh install routes the popup straight to Connect Vanderbilt with the open-full-page hint');

  // Step 2: options.html also defaults to setup; pair against the mock kernel.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.locator('#setup-heading').waitFor();
  await options.locator('#pairing').fill(`${endpoint}#${TOKEN}`);
  await options.getByRole('button', { name: 'Pair' }).click();
  await options.locator('[data-slot="paired"]').filter({ hasText: endpoint }).waitFor();
  console.log('PASS options page defaults to setup and pairs with the mock kernel');

  // Step 3: save identity, consent, and connect — the full deterministic setup call.
  await options.locator('#vu-identity').fill('onboarding-smoke');
  await options.getByRole('button', { name: 'Save account', exact: true }).click();
  await options
    .getByLabel('I authorize connecting this account and adding a toolkit passkey if needed.')
    .check();
  await options.getByRole('button', { name: 'Connect account', exact: true }).click();
  await options.getByText('Vanderbilt setup completed', { exact: false }).waitFor();
  console.log('PASS identity save and consent complete the deterministic setup call');

  // Step 4: SetupPanel's onConnected callback persisted the onboarded flag.
  await options.waitForFunction(() =>
    chrome.storage.local.get('onboarded').then((result) => result.onboarded === true),
  );
  const stored = await options.evaluate(() => chrome.storage.local.get('onboarded'));
  assert.equal(stored.onboarded, true, 'onboarded flag persisted to storage.local after connect');
  console.log('PASS onboarded flag persisted to storage.local after a verified connection');

  // Step 5: a fresh popup no longer shows the onboarding hint.
  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${id}/popup.html`);
  await popup2.locator('#endpoint').waitFor();
  assert.equal(
    await popup2.getByText('Continue in the full page', { exact: false }).count(),
    0,
    'the open-full-page onboarding hint should not reappear once onboarded',
  );
  console.log('PASS a reopened popup no longer shows the onboarding hint');

  if (failures.length) throw new Error(`the extension raised: ${failures.join('; ')}`);
  console.log('PASS no uncaught page errors');
} finally {
  await context.close();
  kernel.close();
  rmSync(profile, { recursive: true, force: true });
}
