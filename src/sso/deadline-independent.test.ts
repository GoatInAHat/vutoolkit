import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withCdpTab, type CdpTab } from './cdp-driver.js';
import { ensureSession } from './ensure.js';
import { FileSessionStore } from '../vault/file-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs: string[] = [];
import { withCallerBudget } from './budget.js';
vi.mock('./cdp-driver.js', async original => ({ ...await original<typeof import('./cdp-driver.js')>(), withCdpTab: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); for (const dir of dirs) rmSync(dir, {recursive:true, force:true}); });
it('does not arm a credential after caller abort during real ceremony setup', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const send = vi.fn(async (method: string) => {
    if (method === 'Page.enable') controller.abort();
    if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'fake' };
    if (method === 'WebAuthn.getCredentials') return { credentials: [{ credentialId: 'YWJj', signCount: 6 }] };
    if (method === 'Storage.getCookies') return { cookies: [] };
    return {};
  });
  vi.mocked(withCdpTab).mockImplementation(async (_url, _start, fn) => fn({ tabId: 'fake', send: send as CdpTab['send'], evaluate: async () => ({ url: 'https://onevu.vanderbilt.edu/app/UserHome', identifier: false, webauthn: false, error: '' }) }));
  const dir = mkdtempSync(join(tmpdir(), 'vutoolkit-independent-')); dirs.push(dir);
  const store = new FileSessionStore(join(dir, 'sessions.vault.json'));
  let raw = JSON.stringify({credentialId:'YWJj',privateKey:'synthetic',userHandle:'dXNlcg',rpId:'vanderbilt.edu',signCount:4});
  const op = withCallerBudget({name:'sessions.refresh', description:'independent boundary probe', input:z.object({}), handler: async () => ensureSession('vanderbilt', store, {
    forceRefresh:true, env:{VUTOOLKIT_CDP_URL:'http://127.0.0.1:18800'}, ensureBrowser:async()=>{},
    secretsRead:name=>name==='VANDERBILT_EMAIL'?'synthetic@example.invalid':raw,
    secretsWrite:async(_name,value)=>{raw=value;}, retryDelayMs:0,
  })});
  const pending = op.handler({}, {config:{}, dataDir:'/unused', signal:controller.signal} as never);
  const rejected = expect(pending).rejects.toThrow();
  await vi.runAllTimersAsync();
  await rejected;
  expect(send.mock.calls.filter(([method]) => method === 'WebAuthn.addCredential')).toHaveLength(0);
});

const key = { credentialId:'YWJj', privateKey:'synthetic', userHandle:'dXNlcg', rpId:'vanderbilt.edu', signCount:4 };
function realChain(options: { abortAt?: string; fault?: 'harvest'|'page'|'counter'|'write'|'readback'; restart?: boolean } = {}) {
  vi.useFakeTimers();
  const controller = new AbortController();
  let raw = JSON.stringify(key);
  const writes: number[] = [];
  let count = 5;
  let navigations = 0;
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === options.abortAt && (method !== 'WebAuthn.setAutomaticPresenceSimulation' || params?.enabled === false)) controller.abort();
    if (method === 'WebAuthn.addCredential') count = (params?.credential as {signCount:number}).signCount;
    if (method === 'WebAuthn.addVirtualAuthenticator') return {authenticatorId:'fake'};
    if (method === 'Page.navigate' && params?.url !== 'about:blank') {
      navigations++; count++;
      if (options.fault === 'page') throw new Error('navigation failed after assertion');
    }
    if (method === 'WebAuthn.getCredentials') {
      if (options.fault === 'counter') throw new Error('counter unavailable');
      return {credentials:[{credentialId:key.credentialId,signCount:count}]};
    }
    if (method === 'Storage.getCookies') {
      if (options.fault === 'harvest') throw new Error('harvest failed');
      return {cookies:[{name:'idx',value:'synthetic',domain:'onevu.vanderbilt.edu',path:'/'}]};
    }
    return {};
  });
  vi.mocked(withCdpTab).mockImplementation(async (_url,_start,fn) => fn({tabId:'fake',send:send as CdpTab['send'],evaluate:async () => ({url:options.restart?'https://onevu.vanderbilt.edu/oauth2/v1/authorize':'https://onevu.vanderbilt.edu/app/UserHome',identifier:false,webauthn:false,verifying:options.restart,error:''})}));
  const dir = mkdtempSync(join(tmpdir(),'vutoolkit-boundary-')); dirs.push(dir);
  const store = new FileSessionStore(join(dir,'sessions.vault.json'));
  const deps = {forceRefresh:true,signal:controller.signal,env:{VUTOOLKIT_CDP_URL:'http://127.0.0.1:18800'},ensureBrowser:async()=>{},secretsRead:(name:string)=>name==='VANDERBILT_EMAIL'?'synthetic@example.invalid':raw,secretsWrite:async(_name:string,value:string)=>{ if(options.fault==='write') throw new Error('write failed'); if(options.fault!=='readback') raw=value; writes.push(JSON.parse(value).signCount); },retryDelayMs:0};
  return {controller,send,writes,store,deps,count:()=>JSON.parse(raw).signCount,navigations:()=>navigations,run:()=>ensureSession('vanderbilt',store,deps)};
}
it.each(['WebAuthn.enable','WebAuthn.addVirtualAuthenticator'])('abort at %s does not install or navigate',async abortAt=>{
  const c=realChain({abortAt}); const rejected=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await rejected;
  expect(c.send.mock.calls.filter(([m])=>m==='WebAuthn.addCredential')).toHaveLength(0);
  expect(c.navigations()).toBe(0);
});
it('abort while quiescing verification prevents an internal restart but accounts its used counter',async()=>{
  const c=realChain({restart:true,abortAt:'WebAuthn.setAutomaticPresenceSimulation'});
  const rejected=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await rejected;
  expect(c.send.mock.calls.filter(([m])=>m==='WebAuthn.addCredential')).toHaveLength(1);
  expect(c.navigations()).toBe(1); expect(c.count()).toBe(6); expect(c.writes).toEqual([6]);
});
it.each(['harvest','page'] as const)('durably accounts an assertion after %s failure before retry',async fault=>{
  const c=realChain({fault}); const rejected=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await rejected;
  expect(c.count()).toBeGreaterThanOrEqual(6); expect(c.writes[0]).toBe(6);
  const installed=c.send.mock.calls.filter(([m])=>m==='WebAuthn.addCredential');
  if(installed.length>1) expect((installed[1][1]?.credential as {signCount:number}).signCount).toBeGreaterThanOrEqual(7);
});
it.each(['counter','write','readback'] as const)('fails closed after %s accounting uncertainty without another assertion',async fault=>{
  const c=realChain({fault}); const rejected=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await rejected;
  const again=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await again;
  expect(c.send.mock.calls.filter(([m])=>m==='WebAuthn.addCredential')).toHaveLength(1);
});
it('abort after assertion accounts the counter without publishing a session',async()=>{
  const c=realChain({abortAt:'Storage.getCookies'}); const rejected=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await rejected;
  expect(c.writes).toEqual([6]); expect(c.count()).toBe(6); expect(await c.store.get('vanderbilt')).toBeNull();
});
it('accounting failure plus abort remains quarantined for a fresh caller',async()=>{
  const c=realChain({fault:'write',abortAt:'WebAuthn.getCredentials'});
  const first=expect(c.run()).rejects.toThrow(); await vi.runAllTimersAsync(); await first;
  const second=expect(ensureSession('vanderbilt',c.store,{...c.deps,signal:undefined})).rejects.toThrow(/quarantined/);
  await vi.runAllTimersAsync(); await second;
  expect(c.send.mock.calls.filter(([m])=>m==='WebAuthn.addCredential')).toHaveLength(1);
});
it('real ceremony preserves a surviving independently signalled waiter',async()=>{
  const c=realChain({abortAt:'Page.enable'});
  const first=expect(c.run()).rejects.toThrow();
  const survivor=ensureSession('vanderbilt',c.store,{...c.deps,signal:new AbortController().signal});
  await vi.runAllTimersAsync(); await first;
  await expect(survivor).resolves.toMatchObject({source:'minted',assertedSignCount:6});
  expect(c.send.mock.calls.filter(([m])=>m==='WebAuthn.addCredential')).toHaveLength(1);
  expect(c.writes).toEqual([6]);
});
