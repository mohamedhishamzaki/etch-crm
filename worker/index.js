const headers = {'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const maximumBytes = 1500000;
const publicOrigin = 'https://masar-crm-261118.mohamed-hisham-zaki.chatgpt.site';
function json(value,status=200) {
  return Response.json(value,{status,headers});
}
function allowedWrite(request, env) {
  const email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  return Boolean(email && env.ETCH_OWNER_EMAIL && email===env.ETCH_OWNER_EMAIL.trim().toLowerCase());
}
function allowLiveViewer(request,env) {
  const email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  return Boolean(email && (env.ETCH_LIVE_VIEWER_EMAILS || '').split(',').some(value=>value.trim().toLowerCase()===email));
}
const identity = request => request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase() || '';
const teamMembers = env => {
  try {
    const members=JSON.parse(env.ETCH_SALES_TEAM || '{}');
    const entries=Object.entries(members).filter(([email,name])=>email.includes('@') && typeof name==='string' && name.trim())
      .map(([email,name])=>[email.trim().toLowerCase(),name.trim()]);
    return Object.fromEntries(entries.filter(([email,name])=>entries.filter(([otherEmail,otherName])=>otherEmail===email || otherName===name).length===1));
  } catch { return {}; }
};
function salesProjection(records,name) {
  const deals=records.deals.filter(deal=>deal.owner===name);
  const companyIds=new Set(deals.map(deal=>deal.company));
  const contactIds=new Set(deals.flatMap(deal=>[deal.contact,...(deal.roles || []).map(role=>role.contact)]));
  return {
    deals,
    assignedTasks:records.deals.filter(deal=>deal.owner!==name).flatMap(deal=>(deal.tasks || [])
      .filter(task=>task.owner===name).map(task=>({dealId:deal.id,task}))),
    companies:records.companies.filter(company=>companyIds.has(company.id)).map(company=>({id:company.id,name:company.name,industry:company.industry || '',notes:''})),
    contacts:records.contacts.filter(contact=>companyIds.has(contact.company) && contactIds.has(contact.id))
      .map(contact=>({id:contact.id,company:contact.company,name:contact.name,role:contact.role || '',phone:contact.phone || '',mobile:contact.mobile || '',email:contact.email || '',notes:''}))
  };
}
const editableDealFields=['name','stage','stageOn','amount','probability','currency','close','next','due','method','lastContact','followupOwner','priority','forecast','notes','actualAmount','actualClose','loss','remindAt','tasks','checks','budget','requestType','requestedModule','requestedSapProduct','source'];
const dateOnly=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
const cairoDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
function validDealUpdate(deal,current) {
  if (typeof deal.name!=='string' || !deal.name.trim() || !Number.isInteger(deal.stage) || deal.stage<0 || deal.stage>5) return false;
  if (editableDealFields.some(field=>!['stage','tasks','checks'].includes(field) && deal[field]!==undefined && typeof deal[field]!=='string')) return false;
  if (['close','due','actualClose','lastContact','stageOn'].some(field=>deal[field] && !dateOnly(deal[field]))) return false;
  if (['amount','actualAmount','budget','probability'].some(field=>deal[field] && (!Number.isFinite(Number(deal[field])) || Number(deal[field])<0)) || Number(deal.probability)>100) return false;
  if (deal.tasks!==undefined && (!Array.isArray(deal.tasks) || deal.tasks.some(task=>!task ||
    !task.id || typeof task.id!=='string' || typeof task.title!=='string' || !task.title.trim() || typeof task.owner!=='string' ||
    !['مكالمة','إيميل','اجتماع','إرسال عرض','مهمة أخرى'].includes(task.type) || !(task.due==='' || dateOnly(task.due)) || typeof task.done!=='boolean') || new Set(deal.tasks.map(t=>t.id)).size!==deal.tasks.length)) return false;
  if (deal.checks!==undefined && (!Array.isArray(deal.checks) || deal.checks.some(key=>!['needAgreed','decisionKnown','budgetKnown','proposalReviewed'].includes(key)))) return false;
  if (deal.stage===current.stage) return true;
  if (deal.stage===2) return Boolean(deal.next && deal.due && deal.owner);
  if (deal.stage===4) return Boolean(deal.actualAmount && deal.actualClose);
  if (deal.stage===5) return Boolean(deal.loss);
  return true;
}
async function saveDeal(env,actor,owner,sales,payload) {
  const {base,deal,operation}=payload || {};
  if (!base || !deal || typeof deal.id!=='string' || base.id!==deal.id || !Array.isArray(base.history) || !Array.isArray(deal.history) || typeof operation!=='string' || !operation || operation.length>100) return json({error:'invalid'},400);
  for (let attempt=0;attempt<8;attempt++) {
    const row=await env.DB.prepare('SELECT revision, records FROM shared_crm WHERE id=1').first();
    const records=row && migrateLeadOwners(JSON.parse(row.records));
    const index=records?.deals.findIndex(item=>item.id===deal.id);
    const current=records?.deals[index];
    if (!current || (!owner && current.owner!==sales)) return json({error:'missing'},404);
    if (current.history.some(event=>event.saveOperation===operation && event.actor===actor)) return json({deal:current});
    if (JSON.stringify(current)!==JSON.stringify(base)) return json({error:'deal_conflict',deal:current},409);
    const updated=owner?{...deal}:{...current};
    if (!owner) for (const field of editableDealFields) if (Object.hasOwn(deal,field)) updated[field]=deal[field];
    if (!validDealUpdate(updated,current)) return json({error:'invalid'},400);
    if (!owner && (current.tasks || []).some(task=>task.owner!==sales &&
      JSON.stringify(task)!==JSON.stringify(updated.tasks?.find(candidate=>candidate.id===task.id)))) return json({error:'task_scope'},403);
    if (updated.company && !records.companies.some(company=>company.id===updated.company) || updated.contact && !records.contacts.some(contact=>contact.id===updated.contact && contact.company===updated.company) || updated.roles!==undefined && (!Array.isArray(updated.roles) || updated.roles.some(role=>!role || !records.contacts.some(contact=>contact.id===role.contact && contact.company===updated.company)))) return json({error:'invalid_link'},400);
    const stamp=new Date().toISOString();
    const appended=deal.history.slice(base.history.length);
    if (appended.some(event=>!event || typeof event.text!=='string' || !Number.isFinite(Date.parse(event.at)))) return json({error:'invalid_history'},400);
    const activityFields=['operation','activityType','completedTask','next','due','followupOwner'];
    if (appended.some(event=>event.kind==='activity' && (!['call','meeting','visit','email','note','schedule'].includes(event.activityType) || typeof event.operation!=='string' || activityFields.some(field=>event[field]!==undefined && typeof event[field]!=='string')))) return json({error:'invalid_history'},400);
    updated.history=[...current.history,...appended.filter(event=>event.kind===undefined || event.kind==='activity').map(event=>({
      text:event.text,actor,at:stamp,...(event.kind==='activity'?{kind:'activity',companyId:updated.company,contactId:updated.contact,
        ...Object.fromEntries(activityFields.filter(field=>Object.hasOwn(event,field)).map(field=>[field,event[field]]))}:{})
    }))];
    for (const [field,kind] of [['stage','stage'],['amount','amount'],['close','close']]) {
      const before=current[field] ?? '',after=updated[field] ?? '';
      if (before===after || kind==='amount' && before && after && Number(before)===Number(after)) continue;
      const original=appended.find(event=>event.kind===kind && event.before===before && event.after===after);
      updated.history.push({kind,before,after,actor,at:stamp,text:original?.text || String(before)+' → '+String(after)});
    }
    if (updated.history.length===current.history.length) updated.history.push({actor,at:stamp,text:'Deal updated'});
    updated.history[updated.history.length-1].saveOperation=operation;
    const next={...records,deals:records.deals.map(item=>item.id===deal.id?updated:item)};
    const encoded=JSON.stringify(next);
    if (new TextEncoder().encode(encoded).length>maximumBytes) return json({error:'too_large'},413);
    const saved=await env.DB.prepare('UPDATE shared_crm SET revision=revision+1, records=json_set(records, ?, json(?)), updated_at=? WHERE id=1 AND revision=? RETURNING revision')
      .bind('$.deals['+index+']',JSON.stringify(updated),stamp,row.revision).first();
    if (saved) return json({deal:updated});
  }
  return json({error:'try_again'},503);
}
async function saveAssignedTask(env,actor,sales,payload) {
  const {dealId,base,title,due,done,outcome,activityType,next,nextDue,operation}=payload || {};
  if (typeof dealId!=='string' || typeof base?.id!=='string' || typeof operation!=='string' || !operation || operation.length>100 ||
      typeof title!=='string' || !title.trim() || !(due==='' || dateOnly(due)) || typeof done!=='boolean' ||
      typeof outcome!=='string' || !['call','meeting','visit','email','note'].includes(activityType) || typeof next!=='string' ||
      (next ? !next.trim() || !dateOnly(nextDue) : Boolean(nextDue))) return json({error:'invalid'},400);
  for (let attempt=0;attempt<8;attempt++) {
    const row=await env.DB.prepare('SELECT revision, records FROM shared_crm WHERE id=1').first();
    const records=row && JSON.parse(row.records);
    const index=records?.deals.findIndex(deal=>deal.id===dealId);
    const deal=records?.deals[index];
    const task=deal?.tasks?.find(task=>task.id===base.id);
    if (!task || task.owner!==sales) return json({error:'missing'},404);
    if (deal.history.some(event=>event.saveOperation===operation && event.actor===actor)) return json({task});
    if (JSON.stringify(task)!==JSON.stringify(base)) return json({error:'task_conflict',task},409);
    if (next && (deal.stage>=4 || deal.tasks.some(task=>task.id===operation))) return json({error:'invalid_next'},400);
    const updated={...task,title:title.trim(),due,done};
    const stamp=new Date().toISOString();
    const tasks=deal.tasks.map(task=>task.id===base.id?updated:task);
    if (next) tasks.push({id:operation,title:next.trim(),due:nextDue,owner:sales,type:task.type,done:false,followup:true});
    const event={kind:'activity',activityType:outcome?activityType:'schedule',operation,saveOperation:operation,actor,at:stamp,
      text:outcome || title,companyId:deal.company,contactId:deal.contact,
      ...(done&&!task.done?{completedTask:task.title}:{}),...(next?{next,due:nextDue,followupOwner:sales}:{})};
    const changes={...deal,tasks,history:[...deal.history,event]};
    if (outcome && ['call','meeting','visit','email'].includes(activityType)) changes.lastContact=cairoDate.format(new Date(stamp));
    if (task.followup && deal.next===task.title && deal.due===task.due) {
      Object.assign(changes,done?{next:next.trim(),due:nextDue || '',followupOwner:next?sales:'',method:next?deal.method || '':''}:{next:updated.title,due:updated.due});
    }
    const path='$.deals['+index+']';
    const result=await env.DB.prepare('UPDATE shared_crm SET revision=revision+1, records=json_set(records, ?, json(?)), updated_at=? WHERE id=1 AND revision=? RETURNING revision')
      .bind(path,JSON.stringify(changes),stamp,row.revision).first();
    if (result) return json({task:updated});
  }
  return json({error:'try_again'},503);
}
function demoPage() {
  const date=new Date().toISOString().slice(0,10);
  const future=(days)=>new Date(Date.parse(date)+days*86400000).toISOString().slice(0,10);
  const company=(id,name,industry)=>({id,name,industry,notes:'Fictional company for illustration.'});
  const deals=[
    {id:'d1',name:'Manufacturing ERP rollout',company:'c1',stage:0,amount:'120000',probability:'25',next:'Schedule a discovery call',due:future(7),source:'ترشيح',requestedSapProduct:'SAP S/4HANA Cloud Public Edition'},
    {id:'d2',name:'Finance module expansion',company:'c2',stage:2,amount:'75000',probability:'55',next:'Review the workshop agenda',due:future(2),forecast:'Best case',priority:'عالية',requestedModule:'SAP FI'},
    {id:'d3',name:'People operations modernization',company:'c3',stage:3,amount:'94000',probability:'80',next:'Review the proposal',due:date,forecast:'Commit',requestedSapProduct:'SAP SuccessFactors'},
    {id:'d4',name:'ERP support renewal',company:'c1',stage:4,amount:'35000',probability:'100',actualAmount:'35000',actualClose:date,next:'',due:'',requestType:'دعم وصيانة'}
  ].map(deal=>({contact:'',owner:'Demo Sales Team',currency:'USD',close:date,notes:'Illustrative deal only.',history:[],createdOn:date,stageOn:date,...deal}));
  const records={companies:[
    company('c1','Demo Manufacturing','التصنيع'),
    company('c2','Demo Retail','التجزئة'),
    company('c3','Demo Services','الخدمات المهنية')
  ],contacts:[],deals,targets:{[date.slice(0,7)]:150000}};
  const payload=JSON.stringify({date,contactsVisible:false,records}).replace(/</g,'\u003c');
  return appHtml.replace('<html lang="ar" dir="rtl">','<html lang="ar" dir="rtl" data-snapshot data-demo="true">')
    .replace('id="etch-snapshot"></script>',()=> 'id="etch-snapshot">'+payload+'</script>');
}

function validRecords(records) {
  return records && typeof records==='object' && ['companies','contacts','deals'].every(key=>Array.isArray(records[key]));
}
async function readBody(request) {
  const reader=request.body?.getReader();
  if (!reader) return null;
  let bytes=0;
  let result='';
  const decoder=new TextDecoder();
  while (true) {
    const {done,value}=await reader.read();
    if (done) break;
    bytes+=value.byteLength;
    if (bytes>maximumBytes) { await reader.cancel(); throw new RangeError('size'); }
    result+=decoder.decode(value,{stream:true});
  }
  return JSON.parse(result+decoder.decode());
}
async function shared(request,env,owner,url,sales,team) {
  if (request.method==='GET') {
    const read=()=>env.DB.prepare('SELECT s.revision, s.records, s.updated_at, COALESCE(p.contacts_visible, 0) AS contacts_visible FROM (SELECT 1 AS id) q LEFT JOIN shared_crm s ON s.id=q.id LEFT JOIN shared_crm_privacy p ON p.id=q.id').first();
    let row=await read();
    const viewer=!owner && !sales || url.searchParams.get('viewer')==='1';
    let original=row.records?JSON.parse(row.records):null;
    let records=original?migrateLeadOwners(original):null;
    if (owner && !viewer && records!==original) {
      const stamp=new Date().toISOString();
      const updated=await env.DB.prepare('UPDATE shared_crm SET revision=revision+1, records=?, updated_at=? WHERE id=1 AND revision=? RETURNING revision')
        .bind(JSON.stringify(records),stamp,row.revision).first();
      if (updated) row={...row,revision:updated.revision,updated_at:stamp};
      else {
        row=await read();
        original=row.records?JSON.parse(row.records):null;
        records=original?migrateLeadOwners(original):null;
      }
    }
    const contactsVisible=Boolean(row.contacts_visible);
    if (viewer && records) records={...records,deals:records.deals.map(({remindAt,...deal})=>deal)};
    if (sales && !owner) records=records?salesProjection(records,sales):null;
    else if (viewer && !contactsVisible && records) records=projectManagerRecords(records);
    return json({revision:row.revision || 0,records,updatedAt:row.updated_at,contactsVisible:sales && !owner?true:contactsVisible,
      ...(owner&&!viewer || sales&&!owner?{owners:Object.values(team)}:{}),...(sales&&!owner?{salesName:sales}:{})});
  }
  if (!['PUT','PATCH'].includes(request.method)) return json({error:'method'},405);
  if (!owner) return json({error:'read_only'},403);
  const origin=request.headers.get('origin');
  if (origin!==publicOrigin && origin!==url.origin) return json({error:'origin'},403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'type'},415);
  let payload;
  try { payload=await readBody(request); } catch (error) { return json({error:error instanceof RangeError?'too_large':'invalid'},error instanceof RangeError?413:400); }
  if (request.method==='PATCH') {
    if (typeof payload?.contactsVisible!=='boolean') return json({error:'invalid'},400);
    await env.DB.prepare('INSERT INTO shared_crm_privacy (id, contacts_visible) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET contacts_visible=excluded.contacts_visible')
      .bind(payload.contactsVisible?1:0).run();
    return json({contactsVisible:payload.contactsVisible});
  }
  if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision<0 || !validRecords(payload.records)) return json({error:'invalid'},400);
  const records=JSON.stringify(migrateLeadOwners(payload.records));
  const stamp=new Date().toISOString();
  const row=payload.revision===0
    ? await env.DB.prepare('INSERT INTO shared_crm (id, revision, records, updated_at) VALUES (1, 1, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING revision').bind(records,stamp).first()
    : await env.DB.prepare('UPDATE shared_crm SET revision=revision+1, records=?, updated_at=? WHERE id=1 AND revision=? RETURNING revision').bind(records,stamp,payload.revision).first();
  return row ? json({revision:row.revision,updatedAt:stamp}) : json({error:'conflict'},409);
}
const officeOrigin='https://jupiter-sap-office.mohamed-hisham-zaki.chatgpt.site';
const officeContactHeaders={...headers,'access-control-allow-origin':officeOrigin,'access-control-allow-credentials':'true',vary:'Origin'};
const companyKey=value=>String(value??'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
async function officeContacts(env,company){
 const key=companyKey(company);
 if(!key)return [];
 const row=await env.DB.prepare('SELECT records FROM shared_crm WHERE id=1').first();
 const data=row?.records?JSON.parse(row.records):null;
 const ids=new Set((data?.companies||[]).filter(c=>companyKey(c.name)===key).map(c=>c.id));
 return (data?.contacts||[]).filter(c=>ids.has(c.company))
  .map(c=>({name:String(c.name||'').trim(),position:String(c.role||'').trim(),phone:String(c.mobile||c.phone||'').trim()}))
  .filter(c=>c.name||c.position||c.phone).sort((a,b)=>Number(Boolean(b.phone))-Number(Boolean(a.phone)));
}
async function officeContactResponse(request,env,url,owner){
 const api=url.pathname==='/api/office-contact';
 const origin=request.headers.get('origin');
 if(!owner||api&&origin!==officeOrigin)return new Response('Access denied',{status:403,headers:officeContactHeaders});
 if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers:officeContactHeaders});
 const company=(url.searchParams.get('company')||'').slice(0,200);
 const contacts=await officeContacts(env,company);
 if(api)return new Response(JSON.stringify({contacts}),{headers:{...officeContactHeaders,'content-type':'application/json; charset=utf-8'}});
 const serialized=JSON.stringify({type:'jupiter-office-contact',company,contacts}).replace(/</g,'\\u003c');
 const html='<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>تحميل جهة الاتصال</title><p>يمكنك الرجوع لمكتب Jupiter 2000.</p><script>if(window.opener){window.opener.postMessage('+serialized+','+JSON.stringify(officeOrigin)+');window.close()}</script></html>';
 return new Response(html,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'"}});
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);

    if (url.pathname==='/api/push/dispatch') return dispatchMobilePush(request,env);
    if (request.method==='GET' || request.method==='HEAD') {
      if (url.pathname==='/etch-push.js') return new Response(request.method==='HEAD'?null:pushService,{headers:{...headers,'content-type':'application/javascript'}});
      if (url.pathname==='/etch-icon.png') return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(iconPng),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png','cache-control':'public, max-age=3600'}});
      if (url.pathname==='/etch.webmanifest') return new Response(request.method==='HEAD'?null:JSON.stringify({
        id:'/',name:'ETCH CRM',short_name:'ETCH CRM',start_url:'/',scope:'/',display:'standalone',
        background_color:'#101421',theme_color:'#17182c',lang:'ar',dir:'rtl',
        icons:[{src:'/etch-icon.png',sizes:'512x512',type:'image/png',purpose:'any'}]
      }),{headers:{'content-type':'application/manifest+json','cache-control':'public, max-age=3600'}});
    }
    if (!request.headers.get('oai-authenticated-user-id')) return json({error:'sign_in_required'},401);
    const owner=allowedWrite(request,env);
    if (url.pathname==='/api/office-contact'||url.pathname==='/office-contact') return officeContactResponse(request,env,url,owner);
    const team=teamMembers(env);
    const email=identity(request);
    const sales=Object.hasOwn(team,email)?team[email]:'';
    const canRead=owner || sales || allowLiveViewer(request,env);
    if (['/api/shared-crm/deal','/api/shared-crm/task'].includes(url.pathname)) {
      if (!owner && !sales) return json({error:'read_only'},403);
      if (request.method!=='PUT') return json({error:'method'},405);
      if (![publicOrigin,url.origin].includes(request.headers.get('origin'))) return json({error:'origin'},403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({error:'type'},415);
      let payload;
      try { payload=await readBody(request); } catch (error) { return json({error:'invalid'},error instanceof RangeError?413:400); }
      if (url.pathname.endsWith('/task')) return sales?saveAssignedTask(env,email,sales,payload):json({error:'denied'},403);
      return saveDeal(env,email,owner,sales,payload);
    }
    if (url.pathname==='/api/push/device') {
      if (!owner) return json({error:'denied'},403);
      try { return await pushDevice(request,env); }
      catch { return json({error:'push_request_failed'},400); }
    }
    if (url.pathname==='/api/shared-crm') {
      if (!canRead) return json({error:'demo_only'},403);
      return shared(request,env,owner,url,sales,team);
    }
    if (!['/','/index.html','/manager','/manager/','/demo','/demo/'].includes(url.pathname)) return json({error:'missing'},404);
    if (request.method!=='GET' && request.method!=='HEAD') return json({error:'method'},405);
    if (!canRead || url.pathname.startsWith('/demo')) {
      return new Response(request.method==='HEAD'?null:demoPage(),{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
    }
    const mode=owner && !url.pathname.startsWith('/manager')?'owner':sales && !owner?'sales':'viewer';
    const actor=mode==='viewer'?'':email;
    const actorAttribute=actor?' data-actor="'+actor.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))+'"':'';
    const app=appHtml.replace('<html lang="ar" dir="rtl">','<html lang="ar" dir="rtl" data-live-mode="'+mode+'"'+actorAttribute+'>');
    return new Response(request.method==='HEAD'?null:app,{headers:{...headers,'content-type':'text/html; charset=utf-8'}});
  }
};
