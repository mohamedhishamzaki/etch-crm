import assert from 'node:assert/strict';
import {test} from 'node:test';
import {api,fixture} from './team-fixture.mjs';

const deals='/api/shared-crm/deal';
const update=(base,fields,operation)=>({base,deal:{...base,...fields},operation});

test('shared account scope uses the authenticated user and applies to direct requests',async()=>{
  const {env,records}=fixture();
  const [a,b]=records.deals;
  const response=await api(env,'ada');
  const {records:visible}=await response.json();
  assert.deepEqual(visible.deals.map(deal=>deal.id),[a.id]);
  assert.deepEqual(visible.contacts.map(contact=>contact.id),['contact-a']);
  assert.equal(visible.companies[0].notes,'');
  assert.deepEqual(visible.assignedTasks.map(({dealId,task})=>[dealId,task.id]),[['deal-b','delegated']]);
  assert.doesNotMatch(JSON.stringify(visible),/Sample support renewal|Example Engineer/);
  assert.equal((await api(env,'viewer',deals,update(a,{amount:'2000'},'viewer-write'))).status,403);
  const viewer=(await (await api(env,'viewer')).json()).records;
  assert.deepEqual(viewer.contacts,[]);
  assert.equal((await api(env,'ada',deals,update(b,{amount:'2200'},'outside'))).status,404);
  assert.equal((await api(env,'ada','/api/shared-crm',{revision:1,records})).status,403);
});

test('task assignment allows atomic work without exposing the parent opportunity',async()=>{
  const {env,records}=fixture();
  const deal=records.deals[1];
  const task=deal.tasks[0];
  const payload={dealId:deal.id,base:task,title:task.title,due:task.due,done:true,
    activityType:'call',outcome:'Assigned fictional callback completed',next:'Prepare next callback',nextDue:'2026-12-24',operation:'delegated-save'};
  const endpoint='/api/shared-crm/task';
  assert.equal((await api(env,'sam',endpoint,payload)).status,404);
  assert.equal((await api(env,'viewer',endpoint,payload)).status,403);
  for (let attempt=0;attempt<2;attempt++) {
    const response=await api(env,'ada',endpoint,payload);
    assert.equal(response.status,200);
    assert.deepEqual(Object.keys(await response.json()),['task']);
  }
  const {records:saved}=await (await api(env,'owner')).json();
  const updated=saved.deals[1];
  assert.equal(updated.tasks[0].done,true);
  assert.equal(updated.tasks[1].title,payload.next);
  assert.equal(updated.tasks.length,2);
  assert.equal(updated.history[0].text,payload.outcome);
  assert.match(updated.lastContact,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await api(env,'sam',deals,update(updated,{tasks:[]},'remove-other-tasks'))).status,403);
});

test('unrelated concurrent deal saves preserve both edits and legacy links and history',async()=>{
  const {env,records}=fixture();
  const [a,b]=records.deals;
  const results=await Promise.all([
    api(env,'ada',deals,update(a,{amount:'1500',owner:'Sam Example',contact:'contact-b'},'a')),
    api(env,'sam',deals,update(b,{close:'2026-12-04'},'b'))
  ]);
  assert.deepEqual(results.map(response=>response.status),[200,200]);
  const {records:saved,revision}=await (await api(env,'owner')).json();
  assert.equal(revision,3);
  assert.equal(saved.deals[0].amount,'1500');
  assert.equal(saved.deals[0].owner,a.owner);
  assert.equal(saved.deals[0].contact,a.contact);
  assert.deepEqual(saved.deals[0].roles,a.roles);
  assert.deepEqual(saved.deals[0].history[0],a.history[0]);
  assert.equal(saved.deals[1].close,'2026-12-04');
  assert.deepEqual(saved.companies,records.companies);
  assert.deepEqual(saved.contacts,records.contacts);
});

test('same-deal concurrent writes surface latest version and retries are idempotent',async()=>{
  const {env,records}=fixture();
  const [a]=records.deals;
  const first=update(a,{close:'2026-12-03'},'closing-a');
  const second=update(a,{close:'2026-12-04'},'closing-b');
  const responses=await Promise.all([api(env,'ada',deals,first),api(env,'owner',deals,second)]);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const winner=responses.findIndex(response=>response.status===200);
  const latest=(await responses[winner].json()).deal;
  assert.deepEqual((await responses[1-winner].json()).deal,latest);
  const retry=await api(env,winner===0?'ada':'owner',deals,winner===0?first:second);
  assert.deepEqual((await retry.json()).deal,latest);
  assert.equal((await (await api(env,'owner')).json()).revision,2);
});

test('contact result, completing prior task and next task are committed once',async()=>{
  const {env,records}=fixture();
  const [a]=records.deals;
  const call={at:'2026-11-25T10:00:00Z',text:'Call again after review',kind:'activity',
    operation:'call-1',activityType:'call',actor:'untrusted@example.test'};
  const next={...a.tasks[0],id:'next-1',title:'Call next month',due:'2026-12-25',followup:true};
  const save=update(a,{next:next.title,due:next.due,tasks:[{...a.tasks[0],done:true},next],history:[...a.history,call]},'call-save');
  for(let attempt=0;attempt<2;attempt++)
    assert.equal((await api(env,'ada',deals,save)).status,200);
  const {records:saved,revision}=await (await api(env,'owner')).json();
  assert.equal(revision,2);
  const [deal]=saved.deals;
  assert.deepEqual(deal.tasks.filter(task=>!task.done),[next]);
  assert.equal(deal.due,next.due);
  const activities=deal.history.filter(event=>event.kind==='activity');
  assert.equal(activities.length,1);
  assert.equal(activities[0].actor,'ada@example.test');
  assert.equal(activities[0].companyId,'north');
});

