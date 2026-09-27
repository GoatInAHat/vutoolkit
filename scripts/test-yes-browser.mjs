/** Production browser acceptance. Real builds; synthetic writes; optional authenticated reads. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '../web/node_modules/playwright/index.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { FileSessionStore } from '../src/vault/file-store.ts';
import { buildDegreeGraph } from '../src/yes/planner.ts';
const profile = await mkdtemp(join(tmpdir(), 'vutoolkit-extension-test-'));
const extension = resolve('hosts/browser/.output/chrome-mv3');
const browser = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const failures = [];
let professorRequests = 0;
const professorKernel = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const rpc = JSON.parse(body);
  assert.equal(rpc.params.name, 'professors.search'); professorRequests++;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { professors: [{ name: 'Example Professor', exactNameMatch: true, rating: 4.5, count: 20, difficulty: 3, wouldTakeAgainPercent: 80, url: 'https://www.ratemyprofessors.com/professor/42' }] } } }));
});
await new Promise((resolve) => professorKernel.listen(0, '127.0.0.1', resolve));
const worker = browser.serviceWorkers()[0] ?? await browser.waitForEvent('serviceworker');
await worker.evaluate((endpoint) => chrome.storage.local.set({ endpoint }), `http://127.0.0.1:${professorKernel.address().port}/mcp`);
const row = (id, section, days, time, action = 'remove') => `<tr class="classRow"><td id="classNumber_${id}" class="classSection">${section}</td><td class="classHours">3.0 hrs</td><td class="classType">Lecture</td><td class="classMeetingDays">${days}</td><td class="classMeetingTimes">${time}</td><td class="classBuilding">Engineering 101</td><td class="classInstructor">Staff</td><td class="classAvailability">Open</td><td class="classActions"><div class="classActionButtons"><a title="${action === 'remove' ? 'Remove Class From Cart' : 'Add this class to your cart'}" href="#" onclick="${action === 'remove' ? `window.cartRemovals.push('${id}');this.closest('tr').remove()` : `window.cartAdds.push('${id}');window.addRow(this)`};return false">${action}</a></div></td></tr>`;
const table = (course, rows) => `<table class="classTable"><tr><td><div class="classHeaderRounded"><span class="classAbbreviation">${course}:</span><span class="classDescription">Test course</span></div></td></tr>${rows}</table>`;
const fixture = (cart, search = '') => `<html><body><script>window.cartRemovals=[];window.cartAdds=[];window.enrolled=false;window.addRow=(link)=>{const row=link.closest('tr').cloneNode(true);const table=link.closest('table').cloneNode(true);table.querySelectorAll('.classRow,.vutoolkit-add-alternatives').forEach(r=>r.remove());const remove=row.querySelector('a[title="Add this class to your cart"]');remove.title='Remove Class From Cart';remove.onclick=()=>{window.cartRemovals.push(row.querySelector('.classSection').id);row.remove();return false};table.append(row);document.querySelector('#studentCart_content').append(table);link.remove()}</script><select id="selectedTerm"><option value="1268">Fall</option><option value="1272">Spring</option></select><div id="searchResults">${search}</div><div id="studentCart_content">${cart}</div><button id="enrollButton-button" onclick="window.enrolled=true">Enroll</button></body></html>`;
const baseCart = table('CS 1101', row('1','01','MWF','10:00a - 11:00a') + row('2','02','MWF','12:00p - 1:00p')) + table('MATH 1300', row('3','01','TR','10:00a - 11:00a'));
try {
  const page = await browser.newPage(); page.on('pageerror', (e) => failures.push(e.message));
  let html = fixture(baseCart);
  await page.route('https://more.app.vanderbilt.edu/**', (route) => route.fulfill({ contentType: 'text/html', body: html }));
  const visit = () => page.goto('https://more.app.vanderbilt.edu/more/SearchClasses!input.action');
  const schedule = () => page.getByRole('button', { name: 'Make schedule', exact: true }).click();
  const preferences = () => page.getByRole('button', { name: 'Preferences', exact: true }).click();
  const save = () => page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  const choices = page.getByRole('button', { name: 'Use this schedule in my cart', exact: true });
  await visit(); await schedule();
  assert.equal(await choices.count(), 2, 'Two non-conflicting alternatives');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await preferences();
  await page.getByLabel('M', { exact: true }).check();
  await page.getByLabel('Free time start', { exact: true }).fill('10:00');
  await page.getByLabel('Free time end', { exact: true }).fill('11:00');
  await page.getByRole('button', { name: 'Add free time', exact: true }).click();
  await page.getByLabel('Hide schedules that overlap preferred free times', { exact: true }).check();
  await save(); await visit(); await preferences();
  assert.equal(await page.getByLabel('Hide schedules that overlap preferred free times', { exact: true }).isChecked(), true, 'Preferences persist after reload');
  await page.getByText('M 10:00–11:00', { exact: true }).waitFor();
  await save(); await schedule();
  assert.equal(await choices.count(), 1, 'Break preferences filter schedules');
  await choices.first().click();
  await page.getByText('Schedule verified in your cart. Enrollment was not changed.', { exact: true }).waitFor();
  const state = await page.evaluate(() => ({ enrolled: window.enrolled, removed: window.cartRemovals, remaining: [...document.querySelectorAll('#studentCart_content .classSection')].map(n => n.id) }));
  assert.deepEqual(state, { enrolled: false, removed: ['1'], remaining: ['classNumber_2', 'classNumber_3'] });
  await visit(); await preferences();
  await page.getByRole('button', { name: 'Clear free-time preferences', exact: true }).click();
  await page.getByLabel('MATH 1300', { exact: true }).uncheck();
  await save(); await schedule();
  assert.equal(await choices.count(), 2);
  await page.selectOption('#selectedTerm', '1272'); await choices.first().click();
  await page.getByText('The selected YES term changed. Rebuild the schedule first.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.cartRemovals.length), 0, 'Changing terms rejects stale schedule before writes');
  await page.selectOption('#selectedTerm', '1268'); await choices.first().click();
  await page.getByText('Schedule verified in your cart. Enrollment was not changed.', { exact: true }).waitFor();
  assert.equal(await page.locator('#classNumber_3').count(), 1, 'Excluded course retained');
  html = fixture('', table('CS 1101', row('4','01','MWF','10:00a - 11:00a','add') + row('5','02','MWF','12:00p - 1:00p','add'))).replaceAll('>Staff<', '>Example Professor<');
  await visit(); await page.getByRole('link', { name: 'RMP 4.5 (20)', exact: true }).first().waitFor();
  assert.equal(professorRequests, 1, 'Repeated instructor lookup is cached');
  await page.getByRole('button', { name: 'Add all sections to cart', exact: true }).click();
  await page.getByText('Cart changes verified; enrollment unchanged.', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => ({ added: window.cartAdds, enrolled: window.enrolled })), { added: ['4', '5'], enrolled: false });
  await preferences();
  await page.getByLabel('Section 01 · Lecture · Example Professor', { exact: true }).waitFor();
  await save();
  await page.getByRole('button', { name: 'Remove course from cart', exact: true }).first().click();
  await page.waitForFunction(() => window.cartRemovals.length === 1);
  console.log('PASS production extension: alternatives, break filtering, persisted preferences, course exclusion, stale-term rejection, bulk add/remove, background-kernel RMP ratings, unpolluted professor metadata, cart-only selection; enrollment untouched (isolated fixture).');
  await page.close();

  const web = await browser.newPage(); web.on('pageerror', (e) => failures.push(e.message));
  const calls = [];
  let identityConfigured = false;
  const audit = { nodes: [{ id: 'requirement:1', kind: 'line', label: 'Synthetic requirement', state: 'needed', hasPossibleCourses: true, coursesNeeded: 1, reportSequence: 1, entrySequence: 2 }, { id: 'course:123', kind: 'course', label: 'CS 2201', state: 'planned', metadata: { courseId: 123, offerNumber: 1 } }], edges: [], note: 'Synthetic official audit' };
  const responses = {
    'degree.graph': () => audit,
    'degree.options': () => ({ courses: [{ courseId: '456', displayName: 'CS 1101', longTitle: 'Introductory Programming' }] }),
    'courses.detail': (args) => { assert.match(args.id, /^\d+$/); return { text: 'Units: 3', description: 'Synthetic course description', prerequisiteText: 'None', prerequisites: { kind: 'all', items: [] } } },
    'courses.sections': () => ({ sections: [{ id: '789', course: 'CS 2201', section: '01', component: 'Lecture', credits: 3, instructors: ['Example Professor'], meetings: [{ days: ['M'], start: 600, end: 660, location: 'Synthetic Room' }] }] }),
    'professors.search': () => ({ professors: [{ id: '42', name: 'Example Professor', rating: 4.5, count: 20, difficulty: 3, wouldTakeAgainPercent: 80, exactNameMatch: true, url: 'https://www.ratemyprofessors.com/professor/42' }], note: 'Student-contributed ratings; verify professor identity.' }),
    'planner.graph': (args) => buildDegreeGraph(args),
    'setup.status': () => ({ identityConfigured, passkeyConfigured: false, nextStep: identityConfigured ? 'Prepare OneVU sign-in.' : 'Save your Vanderbilt account identity.' }),
    'setup.identity': () => { identityConfigured = true; return { identityConfigured: true }; },
    'setup.run': () => ({ status: 'ready', passkey: 'enrolled', passkeyAssertion: 'verified', vanderbiltSession: 'ready', microsoftSession: 'ready', verificationRequired: false }),
  };
  await web.route('https://vutoolkit.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/env') return route.fulfill({ status: 404, body: '' });
    if (url.pathname === '/mcp') {
      const request = route.request().postDataJSON(); calls.push(request.params);
      const response = responses[request.params.name]; assert.ok(response, 'Only explicit fixture operations may run');
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { structuredContent: response(request.params.arguments) } }) });
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
    return route.fulfill({ contentType: types[extname(path)] ?? 'application/octet-stream', body: await readFile(resolve('web/dist') + path) });
  });
  await web.goto('https://vutoolkit.test/');
  await web.getByRole('button', { name: 'Degree planner', exact: true }).click();
  await web.getByRole('button', { name: 'Load my degree audit', exact: true }).click();
  await web.getByRole('button', { name: 'Show official course alternatives', exact: true }).click();
  await web.getByText('1 official alternatives, also added to the graph.', { exact: true }).waitFor();
  assert.equal(await web.locator('svg g[role="button"]').count(), 3, 'Official alternatives expand graph');
  await web.getByRole('button', { name: 'CS 2201 planned', exact: true }).click();
  await web.getByRole('button', { name: 'Official course details', exact: true }).click();
  await web.getByText('Synthetic course description', { exact: true }).waitFor();
  await web.getByRole('button', { name: 'Current sections & professors', exact: true }).click();
  await web.getByText('M 10:00–11:00 · Synthetic Room', { exact: true }).waitFor();
  await web.getByRole('button', { name: 'Professor ratings', exact: true }).click();
  await web.getByRole('link', { name: 'Example Professor', exact: true }).waitFor();
  await web.getByRole('button', { name: 'Map all prerequisites', exact: true }).click();
  await web.getByText('Ranked prerequisite paths', { exact: true }).waitFor();
  assert.ok(calls.some((call) => call.name === 'courses.detail' && call.arguments.id === '123'), 'Official numeric course ID passed');
  await web.getByRole('button', { name: 'CS 2201 planned', exact: true }).click();
  await web.getByRole('button', { name: 'Official course details', exact: true }).waitFor();
  const rankOfficial = web.getByRole('button', { name: 'Rank official requirement paths', exact: true });
  await rankOfficial.click();
  await web.getByText('Scope: supplied official requirement alternatives, explicit goals, and planned courses.', { exact: false }).waitFor();
  const officialRank = calls.find((call) => call.name === 'planner.graph' && Array.isArray(call.arguments.requirements));
  assert.deepEqual(officialRank?.arguments.requirements, [{ id: 'requirement:1', label: 'Synthetic requirement', expression: { kind: 'any', items: [{ kind: 'course', course: 'CS 1101' }] } }], 'Official leaf alternatives reach planner.graph without raw JSON');
  assert.ok(calls.some((call) => call.name === 'courses.detail' && call.arguments.id === '456'), 'Official alternative metadata is loaded before ranking');
  await web.getByRole('button', { name: 'Connect Vanderbilt', exact: true }).click();
  await web.getByLabel('Vanderbilt email or VUnetID', { exact: true }).fill('synthetic@vanderbilt.edu');
  await web.getByRole('button', { name: 'Save account', exact: true }).click();
  const createPasskey = web.getByRole('button', { name: 'Connect account', exact: true });
  await createPasskey.waitFor({ timeout: 5_000 });
  assert.equal(await createPasskey.isDisabled(), true, 'Passkey creation requires identity and consent');
  await web.getByLabel('I authorize connecting this account and adding a toolkit passkey if needed.').check();
  await createPasskey.click();
  await web.getByText('Connection verified', { exact: true }).waitFor();
  assert.equal(calls.filter(c => c.name === 'setup.run').length, 1, 'One deterministic setup call');
  assert.equal(calls.filter(c => ['setup.prepare', 'setup.enroll', 'sessions.ensure'].includes(c.name)).length, 0, 'UI does not orchestrate login steps');
  console.log('PASS production web: audit, accessible directed graph, official alternative expansion, numeric course metadata, section/professor ratings, prerequisite paths, setup consent gating (isolated fixtures).');
  await web.close();

  if (process.env.VUTOOLKIT_LIVE) {
    const store = new FileSessionStore(join(process.env.VUTOOLKIT_DATA_DIR ?? join(homedir(), '.local/share/vutoolkit'), 'sessions.vault.json'));
    const cookies = store.cookies('vanderbilt').map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: Boolean(c.secure), httpOnly: Boolean(c.httpOnly), ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}) }));
    await browser.addCookies(cookies);
    const live = await browser.newPage();
    await live.route('**/*', (route) => { const u = new URL(route.request().url()); if (/StudentClassExecute|PlannedCourseJson|PlannedCourse!remove|SwapEnrollment|DropEnrolled|SelectAssociatedClass|SelectDropIf/i.test(u.pathname) || !['GET', 'HEAD'].includes(route.request().method())) return route.abort(); return route.continue() });
    await live.goto('https://more.app.vanderbilt.edu/more/SearchClasses!input.action', { waitUntil: 'domcontentloaded' });
    if (new URL(live.url()).hostname !== 'more.app.vanderbilt.edu') throw new Error('Live YES browser session not authenticated');
    await live.getByRole('button', { name: 'Make schedule', exact: true }).waitFor();
    if (await live.locator('#selectedTerm').count() !== 1) throw new Error('Live YES term selector missing');
    console.log('PASS production extension mounts on authenticated live YES; mutation requests blocked during test.');
    await live.close();
  }
  assert.deepEqual(failures, [], 'No uncaught production page errors');
} finally { await browser.close(); await new Promise((resolve) => professorKernel.close(resolve)); await rm(profile, { recursive: true, force: true }); }
