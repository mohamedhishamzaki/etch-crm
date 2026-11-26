import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {api,fixture,identities} from './team-fixture.mjs';

const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
const script=html.split('<script>').slice(1).map(part=>part.split('</script>')[0]).join('\n');
const account={id:'demo-account',name:'شركة النور التجريبية',industry:'',notes:''};
const deal={id:'demo-deal',name:'فرصة ERP تجريبية',company:account.id,contact:'',notes:'',stage:0,
  owner:'Demo Owner',next:'الاتصال الأول',due:'2026-11-23',close:'2026-11-25',history:[]};
function app(initial, storage=new Map(), live=null) {
  if (initial) storage.set('masar-crm-v1',JSON.stringify(initial));
  const nodes=new Map();
  let fail=false;
  const document={documentElement:{setAttribute(){},dataset:{actor:live?identities[live.who]:'demo-user@example.test',...(live?{liveMode:live.mode}:{})}},querySelectorAll:()=>[],addEventListener(){},getElementById(id){
    if (!nodes.has(id)) nodes.set(id,{dataset:{},textContent:'',innerHTML:'',open:false,values:{},
      elements:{outcome:{focus(){}},next:{focus(){}},name:{focus(){}}},
      focus(){},querySelectorAll(){return [];},addEventListener(type,fn){this[type]=fn;},setAttribute(){},showModal(){this.open=true;},close(){this.open=false;}});
    return nodes.get(id);
  }};
  class FixedDate extends Date {
    constructor(...args){super(...(args.length?args:['2026-11-23T22:30:00.000Z']));}
    static now(){return new FixedDate().getTime();}
  }
  const context=vm.createContext({Date:FixedDate,document,window:{addEventListener(){}},URLSearchParams,crypto:globalThis.crypto,setInterval(){},
    ...(live?{fetch:(url,options)=>api(live.env,live.who,url,options?.body?JSON.parse(options.body):undefined)}:{}),
    FormData:class {constructor(target){return Object.entries(target.values || {});}},
    localStorage:{getItem:k=>storage.get(k),setItem(k,v){if(fail)throw Error('storage full');storage.set(k,v);}}});
  const run=code=>vm.runInContext(code,context);
  run(script);
  return {run,node:document.getElementById,storage,failSave(value){fail=value;}};
}
const db=(...deals)=>({companies:[account],contacts:[],deals,targets:{}});
function submitActivity(site,values) {
  const form=site.node('quick-followup-form');
  form.values=values;
  form.submit({currentTarget:form,preventDefault(){}});
}
test('daily follow-up form completes old task and records a call with one new date, surviving reload',()=>{
  const site=app(db({...deal,tasks:[{id:'old',title:'Call',owner:'Demo Owner',type:'مكالمة',due:deal.due,done:false}]}));
  assert.equal(site.run('today()'),'2026-11-24');
  assert.match(site.node('results').innerHTML,/متأخرة/);
  site.run("openQuickFollowup('demo-deal')");
  submitActivity(site,{activityType:'call',outcome:'يريد الرجوع بعد شهر',next:'اتصال بعد شهر',due:'2026-12-24',method:'مكالمة',followupOwner:'Demo Owner',taskId:'old'});
  const rebuilt=app(null,site.storage);
  assert.equal(rebuilt.run('data.deals[0].due'),'2026-12-24');
  assert.equal(rebuilt.run('data.deals[0].tasks[0].done'),true);
  assert.equal(rebuilt.run('data.deals[0].history.length'),1);
  assert.equal(rebuilt.run('data.deals[0].history[0].actor'),'demo-user@example.test');
  rebuilt.run("openEditor('companies','demo-account')");
  assert.match(rebuilt.node('history').innerHTML,/يريد الرجوع بعد شهر/);
  assert.match(rebuilt.node('results').innerHTML,/قادمة/);
  assert.doesNotMatch(rebuilt.node('results').innerHTML,/الاتصال الأول/);
});
test('retry follows atomic persistence and the same submission cannot duplicate its activity',()=>{
  const site=app(db(deal));
  site.run("openQuickFollowup('demo-deal')");
  const values={activityType:'meeting',outcome:'Demo outcome',next:'Demo next',due:'2026-12-24'};
  site.failSave(true);
  submitActivity(site,values);
  assert.equal(site.run('data.deals[0].history.length'),0);
  assert.equal(site.run('data.deals[0].due'),'2026-11-23');
  site.failSave(false);
  submitActivity(site,values);
  submitActivity(site,values);
  assert.equal(site.run('data.deals[0].history.length'),1);
});
test('missing upcoming filter excludes closed deals and clears when a follow-up is scheduled',()=>{
  const site=app(db({...deal,next:'',due:''},{...deal,id:'closed',name:'Closed sample',stage:5,next:'',due:''}));
  site.run("workdayFilter='missing';followups();");
  assert.match(site.node('results').innerHTML,/فرصة ERP تجريبية/);
  assert.doesNotMatch(site.node('results').innerHTML,/Closed sample/);
  site.run("openQuickFollowup('demo-deal')");
  submitActivity(site,{activityType:'note',outcome:'Demo note',next:'Demo follow-up',due:'2026-12-25'});
  assert.doesNotMatch(site.node('results').innerHTML,/فرصة ERP تجريبية/);
  site.run("openQuickFollowup('demo-deal')");
  submitActivity(site,{activityType:'note',outcome:'Concluded',noNext:'on'});
  assert.equal(site.run('data.deals[0].due'),'');
  assert.match(site.node('results').innerHTML,/فرصة ERP تجريبية/);
});
test('two close-date changes remain in history and one deal appears in weekly drilldown',()=>{
  const site=app(db(deal));
  site.run("const first=trackDealFields(data.deals[0],{...data.deals[0],close:'2026-11-26'}); const second=trackDealFields(first,{...first,close:'2026-11-27'}); persist({...data,deals:[second]},'');");
  assert.equal(site.run("data.deals[0].history.filter(h=>h.kind==='close').length"),2);
  assert.equal(site.run("managementData('2026-11').pushed.length"),1);
  site.run("view='management';render();showManagementDetails('pushed');");
  const details=site.node('management-details').innerHTML;
  assert.equal(details.split('فرصة ERP تجريبية').length-1,1);
  assert.match(details,/11\/26\/2026|٢٦/);
});
test('company with no deal can log a note and schedule a follow-up',()=>{
  const site=app(db());
  site.run("openQuickFollowup('demo-account','companies')");
  submitActivity(site,{activityType:'note',outcome:'Company note',next:'Check in',due:'2026-12-24'});
  assert.equal(site.run("data.companies[0].history[0].text"),'Company note');
  assert.match(site.node('results').innerHTML,/Check in/);
});

test('within-month delays and rollovers produce distinct matching detail lists',()=>{
  const site=app(db(deal,{...deal,id:'inside',name:'Within November'}));
  site.run(`const first=trackDealFields(data.deals[0],{...data.deals[0],close:'2026-11-26'});
    const crosses=trackDealFields(first,{...first,close:'2026-12-02'});
    const stays=trackDealFields(data.deals[1],{...data.deals[1],close:'2026-11-28'});
    persist({...data,deals:[crosses,stays]},'');`);
  assert.equal(site.run("managementData('2026-11').pushed.length"),2);
  assert.equal(site.run("managementData('2026-11').rolled.length"),1);
  site.run("view='management';render();showManagementDetails('rolled');");
  const details=site.node('management-details').innerHTML;
  assert.match(details,/فرصة ERP تجريبية/);
  assert.doesNotMatch(details,/Within November/);
  assert.match(details,/→/);
});

test('company overview connects contacts and upcoming tasks to the right deals',()=>{
  const other={...deal,id:'second',name:'Second demo deal',contact:'b',next:'Arrange demo',due:'2026-12-24'};
  const data=db({...deal,contact:'a',roles:[{contact:'a',role:'صاحب القرار'}]},other);
  data.contacts=['a','b'].map((id,index)=>({id,company:account.id,name:'Person '+index,role:'Buyer',email:'',phone:'',notes:''}));
  const site=app(data);
  site.run("openEditor('companies','demo-account')");
  const overview=site.node('history').innerHTML;
  for (const item of ['Person 0','Person 1','صاحب القرار','Second demo deal','Arrange demo','data-id="second"']) assert.ok(overview.includes(item),item);
});

test('sales follow-up form saves through the Worker; manager reload sees the activity',async()=>{
  const {env}=fixture();
  const seller=app(null,new Map(),{env,mode:'sales',who:'ada'});
  await until(()=>seller.run('data.deals.length')===1);
  assert.match(seller.node('results').innerHTML,/Sample ERP rollout/);
  assert.doesNotMatch(seller.node('results').innerHTML,/Sample support renewal/);
  seller.run("openQuickFollowup('deal-a')");
  submitActivity(seller,{activityType:'call',outcome:'Asked to call next month',next:'Follow up after month-end',
    due:'2026-12-24',method:'مكالمة',followupOwner:'Ada Example',taskId:'task-old'});
  await until(()=>seller.run('!dealDraft && data.deals[0].due==="2026-12-24"'));
  assert.equal(seller.run("data.deals[0].tasks.filter(t=>!t.done).length"),1);
  const manager=app(null,new Map(),{env,mode:'viewer',who:'viewer'});
  await until(()=>manager.run('data.deals.length')===2);
  manager.run("openEditor('companies','north')");
  assert.match(manager.node('history').innerHTML,/Asked to call next month/);
  assert.match(manager.node('history').innerHTML,/Follow up after month-end/);
  assert.doesNotMatch(manager.node('history').innerHTML,/Example Buyer/);
});

async function until(predicate) {
  for (let attempt=0;attempt<50;attempt++) {
    if (predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('UI did not reach the expected state');
}
