/** Firefox installed-browser runtime proof for the YES content script (docs/ACCEPTANCE.md:83). */
import assert from 'node:assert/strict';
import { firefox } from '../web/node_modules/playwright/index.mjs';
import { connectToFirefox } from '../hosts/browser/node_modules/web-ext/lib/firefox/rdp-client.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

function findFreeTcpPort() {
  return new Promise((done) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); });
  });
}

const profile = await mkdtemp(join(tmpdir(), 'vutoolkit-extension-test-firefox-'));
const extension = resolve('hosts/browser/.output/firefox-mv2');
const port = await findFreeTcpPort();
/**
 * Playwright's bundled Firefox has no native extension-loading flag, and the classic
 * profile proxy-file sideload (a text file at extensions/<gecko-id> pointing at the build
 * output) is silently ignored by it too: writing the proxy file (or an unpacked copy) and
 * launching with xpinstall.signatures.required/extensions.autoDisableScopes/enabledScopes
 * all disabled still leaves extensions.json with no entry for the add-on even after a
 * 15s wait, confirmed by inspecting the profile after launch. web-ext's own temporary-install
 * path works instead: it starts Firefox's legacy Remote Debugging Protocol server
 * (`-start-debugger-server <port>`) and calls the addons actor's installTemporaryAddon with
 * the unpacked build directory, which is the same mechanism `web-ext run` and geckodriver use.
 * That RDP client (web-ext's rdp-client.js) is reused directly here against the very same
 * Playwright-launched Firefox context so the rest of the test still drives pages/assertions
 * through Playwright's normal API.
 */
const context = await firefox.launchPersistentContext(profile, {
  headless: true,
  args: ['-start-debugger-server', String(port)],
  firefoxUserPrefs: {
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'devtools.chrome.enabled': true,
    'xpinstall.signatures.required': false,
  },
});
const failures = [];
try {
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  const geckoId = manifest.browser_specific_settings.gecko.id;

  const client = await connectToFirefox(port);
  const { addonsActor } = await client.request('getRoot');
  assert.ok(addonsActor, 'Firefox RDP root exposes an add-ons actor');
  const installed = await client.request({ to: addonsActor, type: 'installTemporaryAddon', addonPath: extension });
  assert.equal(installed.addon.id, geckoId, 'Firefox build of the extension installs under its declared gecko ID');
  client.disconnect();

  const page = await context.newPage();
  page.on('pageerror', (e) => failures.push(e.message));
  page.on('weberror', (e) => failures.push(e.error().message));
  const fixture = '<!DOCTYPE html><html><body><select id="selectedTerm"><option value="1268">Fall</option></select><div id="searchResults"></div><div id="studentCart_content"></div></body></html>';
  await page.route('https://more.app.vanderbilt.edu/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
  await page.goto('https://more.app.vanderbilt.edu/more/SearchClasses!input.action');
  const schedule = page.getByRole('button', { name: 'Make schedule', exact: true });
  await schedule.waitFor();
  assert.equal(await schedule.isVisible(), true, 'YES content script mounts and renders the Make schedule control');
  console.log('PASS Firefox build of the extension loads via web-ext temporary install and the YES content script mounts with zero page/web errors.');
  assert.deepEqual(failures, [], 'No uncaught errors while the content script was mounted');
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
