import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const source=readFileSync(new URL('../worker/push-service.js',import.meta.url),'utf8');
for (const isOpen of [false,true]) {
  test('notification selects the right CRM route with the app '+(isOpen?'open':'closed'),async()=>{
    const events=new Map();
    const actions=[];
    let notification;
    const origin='https://crm.example.test';
    const client={url:origin+'/',focus:async()=>actions.push('focus'),postMessage:msg=>actions.push(msg.deal)};
    runInNewContext(source,{URL,encodeURIComponent,self:{
      location:{origin},addEventListener:(name,fn)=>events.set(name,fn),
      registration:{showNotification:async(title,{data})=>{notification={data,close(){}};}}
    },clients:{matchAll:async()=>isOpen?[client]:[],openWindow:async url=>actions.push(url)}});
    let pending;
    const waitUntil=promise=>{pending=promise;};
    events.get('push')({data:{json:()=>({dealId:'fixture/&deal'})},waitUntil});
    await pending;
    events.get('notificationclick')({notification,waitUntil});
    await pending;
    assert.deepEqual(actions,isOpen?['focus','fixture/&deal']:['/?view=followups&deal=fixture%2F%26deal']);
  });
}

