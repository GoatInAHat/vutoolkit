import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeEnvironment, readOnlyTestingUrl } from './commodore-access.mjs';
const base='https://augusta.accessiblelearning.com/Vanderbilt/dashboard/Default.aspx';
test('portal read routing rejects writes and foreign navigation',()=>{
  for(const target of ['Testing.aspx?Step=Cancel','Testing.aspx?Step=Accept','Testing.aspx?Step=Schedule','https://other.example/Testing.aspx?Step=Modify','javascript:alert(1)','../SignOut.aspx']) assert.throws(()=>readOnlyTestingUrl(target,base));
  assert.equal(new URL(readOnlyTestingUrl('Testing.aspx?Step=Modify&ID=synthetic',base)).searchParams.get('Step'),'Modify');
});
test('provider proxy configuration is isolated from Chrome, not mutated in the caller',()=>{
  const env={HTTP_PROXY:'synthetic',https_proxy:'synthetic',NO_PROXY:'synthetic',NODE_EXTRA_CA_CERTS:'/synthetic',PATH:'/bin',UNRELATED:'retained'};
  assert.deepEqual(chromeEnvironment(env),{PATH:'/bin',UNRELATED:'retained'});
  assert.equal(env.HTTP_PROXY,'synthetic');
});
