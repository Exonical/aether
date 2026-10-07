import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceConfig } from '../../workspace-config.mjs';
import { readConfig } from '../config.mjs';
import { createAdapter } from '../server.mjs';

const base = {AETHER_TENANT_ID:'test',AETHER_MODEL_ENDPOINT:'https://models.example/v1',AETHER_MODEL_ALLOWLIST:'["fixture"]'};
test('configuration requires explicit tenant, models, secure transport and supported protocol', async () => {
  assert.equal((await readConfig(base)).port,9003);
  for (const patch of [{AETHER_TENANT_ID:''},{AETHER_MODEL_ALLOWLIST:'[]'},{AETHER_MODEL_PROTOCOL:'other'},
    {AETHER_MODEL_ENDPOINT:'http://models.example/v1'},{AETHER_MODEL_ENDPOINT:'https://user:secret@models.example/v1'},
    {AETHER_MODEL_ENDPOINT:'https://models.example/v1?key=secret'},{AETHER_MODEL_ENDPOINT:'https://models.example/v1%2fadmin'},
    {AETHER_MODEL_TOKEN:'secret\nheader'}, {AETHER_MODEL_PORT:'0'}]) await assert.rejects(readConfig({...base,...patch}));
});

async function listen(server) {server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port;}
async function close(server) {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

const probe = `export default {async fetch(req,env) {
  const p=await req.json();
  if (p.gadget) {
    const w=env.LOADER.get('denied',async()=>({compatibilityDate:'2026-09-04',mainModule:'g.js',modules:{'g.js':"export default {async fetch(){try {await fetch('https://models.example/v1/responses');return new Response('allowed')} catch{return new Response('denied')}}}"},globalOutbound:null,env:{}}));
    return w.getEntrypoint().fetch(new Request('http://gadget/'));
  }
  return fetch(p.url,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer caller-secret',cookie:'private=1','x-api-key':'caller-key'},body:JSON.stringify(p.payload),redirect:'manual'});
}};`;
async function harness(adapterPort, run, backendModules = [{name:"probe.js",esModule:probe}]) {
  const scratch=await mkdtemp(join(tmpdir(),'aether-model-native-'));let child, output='';
  try {
    const {binary,directories,config}=await createWorkspaceConfig({namespace:'aether-tenant-test',scratch,assetManifest:{},modelGateway:true,workers:[
      {config:{name:'router',compatibility_date:'2026-09-04',services:[{binding:'BACKEND',service:'workshop-backend'}]},modules:[{name:'router.js',esModule:'export default {fetch(req,env){return env.BACKEND.fetch(req)}}'}]},
      {config:{name:'workshop-backend',compatibility_date:'2026-09-04',compatibility_flags:['nodejs_compat','global_fetch_strictly_public'],kv_namespaces:[{binding:'BLUEPRINTS'}],worker_loaders:[{binding:'LOADER'}]},modules:backendModules},
      ...['gatekeeper-context','gatekeeper-scheduler'].map(name=>({config:{name,compatibility_date:'2026-09-04'},modules:[{name:'stub.js',esModule:"import {WorkerEntrypoint} from 'cloudflare:workers'; export class GatekeeperVendor extends WorkerEntrypoint {} export default {fetch(){return new Response('stub')}}"}]})),
    ]});
    assert.deepEqual(config.services.find(s=>s.name==='internet').network.allow,[]);
    assert.equal(config.services.find(s=>s.name==='router').worker.globalOutbound,undefined);
    await writeFile(join(scratch,'config.bin'),binary);await mkdir(join(scratch,'assets'));
    const socket=createServer();const port=await listen(socket);await close(socket);
    const args=['serve',join(scratch,'config.bin'),'--binary','--experimental','--socket-addr=http=127.0.0.1:'+port,
      '--external-addr=aether:model-endpoint=127.0.0.1:'+adapterPort,'--directory-path=aether:assets-disk='+join(scratch,'assets')];
    for(const {service,subdirectory} of directories){await mkdir(join(scratch,subdirectory),{recursive:true});args.push('--directory-path='+service+'='+join(scratch,subdirectory));}
    child=spawn(createRequire(import.meta.url)('workerd').default,args,{stdio:['ignore','pipe','pipe'],env:{...process.env,AETHER_ADMINS:'[]'}});
    child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);
    const origin='http://127.0.0.1:'+port;
    let ready=false;
    for(let i=0;i<150;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break}}catch{}await delay(20);}
    assert.ok(ready,output);
    await run(async p=>{const result=await fetch(origin+'/probe',{method:'POST',body:JSON.stringify(p)});if(result.status===500)throw new Error(output);return result;});
  } finally {
    if(child && child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
    await rm(scratch,{recursive:true,force:true});
  }
}

test('native Workshop inference streams through scoped transport; redirects, routes, models and Gadget egress are denied', {timeout:30000}, async()=>{
  const seen=[];
  const provider=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;seen.push({url:req.url,headers:req.headers,payload:JSON.parse(body)});
    if(seen.at(-1).payload.input==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/secret'});return res.end('secret');}
    if(seen.at(-1).payload.input==='fail'){res.writeHead(401);return res.end('sensitive provider error');}
    res.writeHead(200,{'content-type':'text/event-stream','set-cookie':'private=1'});
    res.write('data: {"delta":"hello"}\n\n');await delay(20);res.end('data: [DONE]\n\n');
  });
  const port=await listen(provider), endpoint='http://127.0.0.1:'+port+'/v1';
  const adapter=createAdapter(await readConfig({...base,AETHER_MODEL_ENDPOINT:endpoint,AETHER_MODEL_ALLOW_HTTP:'true',AETHER_MODEL_TOKEN:'deployment-secret'}));
  const adapterPort=await adapter.listen(0);
  try {await harness(adapterPort,async call=>{
    const request={url:endpoint+'/responses',payload:{model:'fixture',input:'hello',stream:true,store:true}};
    const result=await call(request);assert.equal(result.status,200);assert.match(await result.text(),/hello.*\n\ndata: \[DONE\]/s);
    assert.equal(result.headers.get('set-cookie'),null);assert.equal(seen[0].payload.store,false);
    assert.equal(seen[0].headers.authorization,'Bearer deployment-secret');assert.equal(seen[0].headers.cookie,undefined);assert.equal(seen[0].headers['x-api-key'],undefined);
    for(const url of [endpoint+'/models',endpoint+'/responses?id=other',endpoint+'/../admin',endpoint.replace('127.0.0.1','localhost')+'/responses','https://api.openai.com/v1/responses']) assert.equal((await call({...request,url})).status,403);
    assert.equal((await call({...request,payload:{model:'other'}})).status,403);assert.equal(seen.length,1);
    assert.equal((await call({...request,payload:{model:'fixture',input:'redirect'}})).status,502);
    const failure=await call({...request,payload:{model:'fixture',input:'fail'}});assert.equal(failure.status,401);assert.doesNotMatch(await failure.text(),/sensitive/);
    assert.equal(await (await call({gadget:true})).text(),'denied');
    assert.equal((await call({...request,payload:{model:'fixture',input:'x'.repeat(8*1024*1024)}})).status,413);
    assert.equal((await call(request)).status,200);
  });}finally{await adapter.close();await close(provider)}
});

test('private CA must be configured; TLS verification stays enabled',async()=>{
  const scratch=await mkdtemp(join(tmpdir(),'aether-model-tls-'));let provider,adapter;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(scratch,'key.pem'),'-out',join(scratch,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
    provider=createHttpsServer({key:await readFile(join(scratch,'key.pem')),cert:await readFile(join(scratch,'cert.pem'))},(req,res)=>{req.resume();res.end('{}')});
    const endpoint='https://127.0.0.1:'+await listen(provider)+'/v1';
    for(const trusted of [false,true]){
      adapter=createAdapter(await readConfig({...base,AETHER_MODEL_ENDPOINT:endpoint,...(trusted?{AETHER_MODEL_CA_FILE:join(scratch,'cert.pem')}:{})}));
      const port=await adapter.listen(0);
      const result=await fetch('http://127.0.0.1:'+port+'/inference',{method:'POST',headers:{'content-type':'application/json','x-aether-model-tenant':'test','x-aether-model-url':endpoint+'/responses'},body:'{"model":"fixture"}'});
      assert.equal(result.status,trusted?200:502);await result.text();await adapter.close();adapter=null;
    }
  }finally{if(adapter)await adapter.close();if(provider)await close(provider);await rm(scratch,{recursive:true,force:true})}
});

test('pinned upstream model SDK completes inference inside native workerd', {skip:process.env.AETHER_TEST_MODEL_SDK!=='true',timeout:30000}, async()=>{
  const backend=new URL('../../../cloudflare-os/packages/workshop-backend/',import.meta.url);
  const {build}=createRequire(new URL('package.json',backend))('esbuild');
  const {outputFiles}=await build({stdin:{contents:`
    import {getModel} from './.wrangler/validate/src/ai-models.ts';
    import {completeText} from './.wrangler/validate/src/ai-invoke.ts';
    export default {async fetch(req,env){const p=await req.json();
      const model=getModel(env,{provider:'ollama',model:'fixture',apiToken:'',apiUrl:p.endpoint},{id:'test',name:'Test',type:'user'});
      return new Response(await completeText(model,{prompt:'Hello'}));
    }};`,resolveDir:fileURLToPath(backend),sourcefile:'aether-probe.ts'},bundle:true,write:false,target:'es2022',format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],external:['cloudflare:workers','node:*'],loader:{'.txt':'text'},plugins:[{name:'text-symlinks',setup(build){build.onResolve({filter:/\.txt$/},args=>({path:join(args.resolveDir,args.path),namespace:'text'}));build.onLoad({filter:/.*/,namespace:'text'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}],tsconfig:fileURLToPath(new URL('tsconfig.json',backend))});
  let seen;
  const provider=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;seen={url:req.url,payload:JSON.parse(body),headers:req.headers};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const chunk of [
      {id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'Hello from on-prem'},finish_reason:null}]},
      {id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7}},
    ])res.write('data: '+JSON.stringify(chunk)+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  const endpoint='http://127.0.0.1:'+await listen(provider)+'/v1';
  const adapter=createAdapter(await readConfig({...base,AETHER_MODEL_ENDPOINT:endpoint,AETHER_MODEL_ALLOW_HTTP:'true'}));
  try{await harness(await adapter.listen(0),async call=>{
    const result=await call({endpoint});assert.equal(result.status,200);assert.equal(await result.text(),'Hello from on-prem');
    assert.equal(seen.url,'/v1/chat/completions');assert.equal(seen.payload.model,'fixture');assert.equal(seen.headers.authorization,undefined);
  },[{name:'sdk.js',esModule:outputFiles[0].text}]);}finally{await adapter.close();await close(provider)}
});

test('Anthropic transport injects only deployment authentication and cancellation releases inference slots',async()=>{
  let requests=0, canceled=0, seen;const pending=[];
  const provider=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;requests++;seen={headers:req.headers,payload:JSON.parse(body)};
    res.on('close',()=>canceled++);pending.push(res);
  });
  const endpoint='http://127.0.0.1:'+await listen(provider)+'/v1';
  const adapter=createAdapter(await readConfig({...base,AETHER_MODEL_ENDPOINT:endpoint,AETHER_MODEL_ALLOW_HTTP:'true',AETHER_MODEL_PROTOCOL:'anthropic',AETHER_MODEL_TOKEN:'anthropic-secret'}));
  try{
    const port=await adapter.listen(0),origin='http://127.0.0.1:'+port;
    const options={method:'POST',headers:{'content-type':'application/json','x-aether-model-tenant':'test','x-aether-model-url':endpoint+'/messages','x-api-key':'caller-secret'},body:'{"model":"fixture","messages":[]}'};
    assert.equal((await fetch(origin+'/inference',{...options,headers:{...options.headers,'x-aether-model-tenant':'other'}})).status,403);
    const aborts=Array.from({length:4},()=>new AbortController());
    const calls=aborts.map(abort=>fetch(origin+'/inference',{...options,signal:abort.signal}).catch(()=>null));
    for(let i=0;i<100 && requests<4;i++)await delay(10);
    assert.equal(requests,4);assert.equal((await fetch(origin+'/inference',options)).status,429);
    assert.equal(seen.headers['x-api-key'],'anthropic-secret');assert.equal(seen.headers['anthropic-version'],'2023-06-01');assert.equal(seen.headers.authorization,undefined);
    aborts.forEach(abort=>abort.abort());await Promise.all(calls);
    for(let i=0;i<100 && canceled<4;i++)await delay(10);
    assert.equal(canceled,4);
    const next=fetch(origin+'/inference',options);
    for(let i=0;i<100 && requests<5;i++)await delay(10);
    assert.equal(requests,5);pending.at(-1).end('{"content":[]}');assert.equal((await next).status,200);
  }finally{await adapter.close();await close(provider)}
});
