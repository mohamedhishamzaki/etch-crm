const encoder = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/,'').replaceAll('+','-').replaceAll('/','_');
const unb64 = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')), c=>c.charCodeAt(0));
function joinBytes(...parts) {
  const result = new Uint8Array(parts.reduce((sum, item)=>sum+item.length,0));
  let offset = 0;
  for (const item of parts) { result.set(item,offset); offset += item.length; }
  return result;
}
async function derive(secret,salt,info,length) {
  const key=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
function validPushSubscription(value) {
  if (!value || typeof value.endpoint!=='string' || value.endpoint.length>2048) return false;
  try {
    const url=new URL(value.endpoint);
    const host=url.hostname;
    return url.protocol==='https:' && !url.port && !url.username && !url.password &&
      (host==='web.push.apple.com' || host.endsWith('.push.apple.com') ||
       host==='fcm.googleapis.com' || host==='updates.push.services.mozilla.com') &&
      /^[A-Za-z0-9_-]+$/.test(value.keys?.p256dh || '') &&
      /^[A-Za-z0-9_-]+$/.test(value.keys?.auth || '') &&
      unb64(value.keys.p256dh).length===65 && unb64(value.keys.auth).length===16;
  } catch { return false; }
}
async function buildMobilePush(subscription, payload, env, topic) {
  if (!validPushSubscription(subscription)) return null;
  const receiver=unb64(subscription.keys.p256dh);
  const sender=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const senderPublic=new Uint8Array(await crypto.subtle.exportKey('raw',sender.publicKey));
  const receiverKey=await crypto.subtle.importKey('raw',receiver,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=await crypto.subtle.deriveBits({name:'ECDH',public:receiverKey},sender.privateKey,256);
  const inputKey=await derive(shared,unb64(subscription.keys.auth),joinBytes(encoder.encode('WebPush: info\0'),receiver,senderPublic),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey('raw',await derive(inputKey,salt,encoder.encode('Content-Encoding: aes128gcm\0'),16),'AES-GCM',false,['encrypt']);
  const iv=await derive(inputKey,salt,encoder.encode('Content-Encoding: nonce\0'),12);
  const plain=joinBytes(encoder.encode(JSON.stringify(payload)),Uint8Array.of(2));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain));
  const body=joinBytes(salt,Uint8Array.of(0,0,16,0,senderPublic.length),senderPublic,encrypted);
  const signingKey=await crypto.subtle.importKey('jwk',JSON.parse(env.ETCH_VAPID_PRIVATE),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const claims={aud:new URL(subscription.endpoint).origin,exp:Math.floor(Date.now()/1000)+3600,sub:publicOrigin};
  const unsigned=b64(encoder.encode(JSON.stringify({typ:'JWT',alg:'ES256'})))+'.'+b64(encoder.encode(JSON.stringify(claims)));
  const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},signingKey,encoder.encode(unsigned));
  return {endpoint:subscription.endpoint,body:b64(body),headers:{
    Authorization:'vapid t='+unsigned+'.'+b64(signature)+', k='+env.ETCH_VAPID_PUBLIC,
    'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'1800',Urgency:'high',...(topic?{Topic:topic}:{})
  }};
}
async function pushDevice(request,env) {
  if (!env.ETCH_VAPID_PUBLIC || !env.ETCH_VAPID_PRIVATE || !env.ETCH_PUSH_SCHEDULER) return json({error:'not_configured'},503);
  if (request.method==='GET') return json({publicKey:env.ETCH_VAPID_PUBLIC});
  if (request.method!=='POST' || request.headers.get('origin')!==publicOrigin) return json({error:'denied'},403);
  const value=await readBody(request);
  if (!validPushSubscription(value?.subscription)) return json({error:'subscription'},400);
  const subscription=value.subscription;
  const endpoint=subscription.endpoint;
  if (value.action==='remove') {
    await env.DB.prepare('DELETE FROM push_devices WHERE endpoint=?').bind(endpoint).run();
    return json({ok:true});
  }
  if (value.action==='test') {
    const device=await env.DB.prepare('SELECT subscription FROM push_devices WHERE endpoint=?').bind(endpoint).first();
    if (!device) return json({error:'subscription'},404);
    const now=Date.now();
    await env.DB.prepare('INSERT INTO push_deliveries (endpoint,reminder_id,lease_until,sent_at) VALUES (?, ?, 0, NULL) ON CONFLICT(endpoint,reminder_id) DO UPDATE SET lease_until=0,sent_at=NULL')
      .bind(endpoint,'test:'+Math.floor(now/60000)).run();
    return json({ok:true,queued:true});
  }
  if (value.action!=='subscribe') return json({error:'action'},400);
  await env.DB.prepare('INSERT INTO push_devices (endpoint,subscription,language,created_at) VALUES (?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription,language=excluded.language')
    .bind(endpoint,JSON.stringify(subscription),value.language==='en'?'en':'ar',new Date().toISOString()).run();
  return json({ok:true});
}
async function dispatchMobilePush(request,env) {
  if (request.method!=='POST' || !env.ETCH_PUSH_SCHEDULER || request.headers.get('authorization')!=='Bearer '+env.ETCH_PUSH_SCHEDULER) return json({error:'denied'},403);
  if (!env.ETCH_VAPID_PUBLIC || !env.ETCH_VAPID_PRIVATE) return json({error:'not_configured'},503);
  if (new URL(request.url).searchParams.has('receipts')) {
    const payload=await readBody(request);
    if (!Array.isArray(payload) || payload.length>20) return json({error:'invalid_receipts'},400);
    for (const receipt of payload) {
      if (typeof receipt?.endpoint!=='string' || typeof receipt.id!=='string' || !Number.isInteger(receipt.status)) continue;
      if (receipt.status===404 || receipt.status===410) {
        await env.DB.prepare('DELETE FROM push_devices WHERE endpoint=?').bind(receipt.endpoint).run();
      } else if (receipt.status>=200 && receipt.status<300) {
        await env.DB.prepare('UPDATE push_deliveries SET sent_at=? WHERE endpoint=? AND reminder_id=?').bind(Date.now(),receipt.endpoint,receipt.id).run();
      }
    }
    return json({ok:true});
  }
  const {results:devices}=await env.DB.prepare('SELECT endpoint,subscription,language,created_at FROM push_devices').all();
  if (!devices.length) return json({jobs:[]});
  if (new URL(request.url).searchParams.has('test')) {
    if (devices.length!==1) return json({error:'test_requires_one_device'},409);
    await env.DB.prepare('INSERT OR IGNORE INTO push_deliveries (endpoint,reminder_id,lease_until,sent_at) VALUES (?,?,0,NULL)')
      .bind(devices[0].endpoint,'test:'+Math.floor(Date.now()/60000)).run();
    return json({queued:true});
  }
  const data=await env.DB.prepare('SELECT records FROM shared_crm WHERE id=1').first();
  const deals=data ? JSON.parse(data.records).deals : [];
  const now=Date.now();
  const due=deals.filter(d=>d.stage<4 && Date.parse(d.remindAt)<=now && Date.parse(d.remindAt)>now-86400000);
  const jobs=[];
  const {results:tests}=await env.DB.prepare("SELECT endpoint,reminder_id FROM push_deliveries WHERE reminder_id LIKE 'test:%' AND sent_at IS NULL AND lease_until<? AND reminder_id>=?").bind(now,'test:'+Math.floor((now-300000)/60000)).all();
  for (const device of devices) {
    const pending=[...tests.filter(test=>test.endpoint===device.endpoint).map(test=>({id:test.reminder_id,test:true})),
      ...due.filter(deal=>Date.parse(deal.remindAt)>=Date.parse(device.created_at)).map(deal=>({id:deal.id+':'+deal.remindAt,dealId:deal.id,test:false}))];
    for (const {id,test,dealId} of pending) {
      if (jobs.length>=20) break;
      const claim=await env.DB.prepare('INSERT INTO push_deliveries (endpoint,reminder_id,lease_until,sent_at) VALUES (?,?,?,NULL) ON CONFLICT(endpoint,reminder_id) DO UPDATE SET lease_until=excluded.lease_until WHERE sent_at IS NULL AND lease_until<? RETURNING reminder_id')
        .bind(device.endpoint,id,now+120000,now).first();
      if (!claim) continue;
      try {
        const topic=b64(await crypto.subtle.digest('SHA-256',encoder.encode(id))).slice(0,32);
        const body=test?(device.language==='en'?'Mobile notification test':'إشعار تجريبي من ETCH CRM'):
          (device.language==='en'?'A follow-up is due. Open ETCH CRM for details.':'حان ميعاد متابعة. افتح ETCH CRM للتفاصيل.');
        const job=await buildMobilePush(JSON.parse(device.subscription),{
          title:'ETCH CRM',body,tag:topic,...(dealId?{dealId}:{})
        },env,topic);
        if (job) jobs.push({...job,id});
      } catch { /* Lease expires so a later run can retry. */ }
    }
  }
  await env.DB.prepare("DELETE FROM push_deliveries WHERE lease_until<? AND reminder_id NOT LIKE 'test:%' OR reminder_id LIKE 'test:%' AND reminder_id<?")
    .bind(now-172800000,'test:'+Math.floor((now-3600000)/60000)).run();
  return json({jobs});
}

