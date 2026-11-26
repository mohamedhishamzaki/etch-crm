import {createServer} from 'node:http';
import {fixture,identities} from './team-fixture.mjs';
import worker from '../dist/server/index.js';

const {env}=fixture(Math.min(1000, Number(process.env.ETCH_TEST_DEALS || 0)));
const port=Number(process.env.ETCH_TEST_PORT || 8773);
const origin='http://127.0.0.1:'+port;
let dropNextDealResponse=false;
createServer(async (req,res)=>{
  try {
    const url=new URL(req.url,origin);
    if (url.searchParams.has('drop-next-response')) dropNextDealResponse=true;
    const persona=url.searchParams.get('as');
    if (Object.hasOwn(identities,persona)) {
      res.writeHead(302,{location:'/', 'set-cookie':'etch-test-role='+persona+'; Path=/; HttpOnly; SameSite=Lax'});
      res.end();
      return;
    }
    const role=/(?:^|; )etch-test-role=([a-z]+)/.exec(req.headers.cookie || '')?.[1] || 'ada';
    const headers=new Headers(req.headers);
    headers.set('oai-authenticated-user-id',role);
    headers.set('oai-authenticated-user-email',identities[role]);
    const body=[];
    for await (const chunk of req) body.push(chunk);
    const request=new Request(url,{method:req.method,headers,...(body.length?{body:Buffer.concat(body)}:{})});
    const result=await worker.fetch(request,env);
    if (dropNextDealResponse && url.pathname==='/api/shared-crm/deal' && req.method==='PUT' && result.ok) {
      dropNextDealResponse=false;
      res.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:'simulated_lost_response'}));
      return;
    }
    res.writeHead(result.status,Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch(error) {
    console.error(error);
    res.writeHead(500).end('Local fixture error');
  }
}).listen(port,'127.0.0.1',()=>console.log(origin));

