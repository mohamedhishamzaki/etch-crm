import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../dist/server/index.js';

export const identities={owner:'owner@example.test',viewer:'viewer@example.test',ada:'ada@example.test',sam:'sam@example.test'};
export function fixture(extraDeals=0) {
  const db=new DatabaseSync(':memory:');
  for (const migration of ['0000_shared_crm','0001_shared_crm_privacy','0002_mobile_push']) {
    db.exec(readFileSync(new URL('../drizzle/'+migration+'.sql',import.meta.url),'utf8'));
  }
  const common={company:'north',notes:'',next:'',due:'',stage:0,close:'2026-11-25',amount:'1000'};
  const task={id:'task-old',title:'Check availability',owner:'Ada Example',done:false,type:'مكالمة',due:'2026-11-22'};
  const records={
    companies:[{id:'north',name:'Northwind Example',industry:'Manufacturing',notes:'Private internal note'}],
    contacts:[
      {id:'contact-a',company:'north',name:'Example Buyer',role:'Buyer',email:'buyer@example.test',phone:'555-0100',notes:''},
      {id:'contact-b',company:'north',name:'Example Engineer',role:'Engineer',email:'engineer@example.test',phone:'555-0101',notes:''}
    ],
    deals:[
      {...common,id:'deal-a',name:'Sample ERP rollout',contact:'contact-a',owner:'Ada Example',next:task.title,due:task.due,tasks:[task],
        roles:[{contact:'contact-a',role:'صاحب القرار'}],
        history:[{kind:'close',text:'Legacy date change',before:'2026-11-21',after:'2026-11-25',at:'2026-11-20T10:00:00Z'}]},
      {...common,id:'deal-b',name:'Sample support renewal',contact:'contact-b',owner:'Sam Example',history:[],
        tasks:[{...task,id:'delegated',title:'Prepare fictional call notes'}]}
    ]
  };
  for (let i=1;i<=extraDeals;i++) {
    const company='fixture-company-'+i;
    records.companies.push({id:company,name:'Training company '+i,industry:'Manufacturing',notes:''});
    records.deals.push({...common,id:'fixture-deal-'+i,name:'Training opportunity '+i,company,contact:'',owner:'Ada Example',
      stage:i%4,next:'Check in',due:'2026-11-'+String(20+i%10),history:[]});
  }
  db.prepare('INSERT INTO shared_crm VALUES (1,1,?,?)').run(JSON.stringify(records),'2026-11-22T09:00:00Z');
  const env={
    ETCH_OWNER_EMAIL:identities.owner,ETCH_LIVE_VIEWER_EMAILS:identities.viewer,
    ETCH_SALES_TEAM:JSON.stringify({[identities.ada]:'Ada Example',[identities.sam]:'Sam Example'}),
    DB:{prepare(sql) {
      const statement=db.prepare(sql);
      const args=[];
      return {
        bind(...values) { args.push(...values); return this; },
        async first() { return statement.get(...args) || null; },
        async run() { return statement.run(...args); }
      };
    }}
  };
  return {env,records,db};
}

export function api(env,who,path='/api/shared-crm',payload,origin='https://crm.example.test') {
  const email=identities[who];
  const headers={'oai-authenticated-user-id':who,'oai-authenticated-user-email':email};
  if (payload) Object.assign(headers,{origin,'content-type':'application/json'});
  return worker.fetch(new Request(origin+path,{headers,...(payload?{method:'PUT',body:JSON.stringify(payload)}:{})}),env);
}

