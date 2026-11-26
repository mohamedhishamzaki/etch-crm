import assert from 'node:assert/strict';
import {test} from 'node:test';
import worker from '../dist/server/index.js';

const origin='https://example.test';
const privateRecords={companies:[{id:'private',name:'Fictional private client'}],contacts:[],deals:[]};
const env={ETCH_OWNER_EMAIL:'owner@example.test',ETCH_LIVE_VIEWER_EMAILS:'manager@example.test',
  DB:{prepare:()=>({first:async()=>({revision:1,records:JSON.stringify(privateRecords),updated_at:'2026-11-24T09:00:00Z',contacts_visible:0})})}};
function request(path,email,method='GET'){
  return new Request(origin+path,{method,headers:email?{'oai-authenticated-user-id':'fictional','oai-authenticated-user-email':email}:{}});
}
test('anonymous and demo viewers cannot read or write live workflow records',async()=>{
  assert.equal((await worker.fetch(request('/api/shared-crm'),env)).status,401);
  for (const method of ['GET','PUT','PATCH']) {
    assert.equal((await worker.fetch(request('/api/shared-crm?viewer=1','limited@example.test',method),env)).status,403);
  }
  for (const path of ['/','/manager']) {
    const html=await (await worker.fetch(request(path,'limited@example.test'),env)).text();
    assert.match(html,/data-demo="true"/);
    assert.doesNotMatch(html,/Fictional private client/);
  }
});
test('authorized manager can read the same source but cannot save or change permissions',async()=>{
  const response=await worker.fetch(request('/api/shared-crm','manager@example.test'),env);
  assert.deepEqual((await response.json()).records,privateRecords);
  assert.equal((await worker.fetch(request('/api/shared-crm','manager@example.test','PUT'),env)).status,403);
  assert.equal((await worker.fetch(request('/api/shared-crm','manager@example.test','PATCH'),env)).status,403);
});
