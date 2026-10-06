import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceConfig } from '../../workspace-config.mjs';

const probe = `export default { async fetch(req,env) {
  const url = new URL(req.url), kv = url.searchParams.get('ns') === 'other' ? env.OTHER : env.BLUEPRINTS;
  if (url.pathname === '/bytes') {
    const key = url.searchParams.get('key') || 'bytes';
    if (req.method === 'PUT') { await kv.put(key, req.body); return new Response('ok'); }
    return new Response(await kv.get(key, 'arrayBuffer'));
  }
  const p = await req.json();
  if (p.action === 'put') { await kv.put(p.key,p.value,p.options); return Response.json('ok'); }
  if (p.action === 'get') return Response.json(await kv.getWithMetadata(p.key,p.type || 'text'));
  if (p.action === 'delete') { await kv.delete(p.key); return Response.json('ok'); }
  if (p.action === 'list') return Response.json(await kv.list(p.options));
  if (p.action === 'bulk') return Response.json(Object.fromEntries(await kv.get(p.keys,{type:p.type || 'text'})));
  return new Response(null,{status:400});
}};`;

export async function nativeHarness(adapterPort, run) {
  const scratch = await mkdtemp(join(tmpdir(), 'aether-pg-native-'));
  let child, output = '';
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child,'exit'); child.kill('SIGTERM');
    const timeout = setTimeout(()=>child.kill('SIGKILL'),5000);
    try { await exited; } finally { clearTimeout(timeout); }
  }
  try {
    const {binary,directories,config} = await createWorkspaceConfig({
      namespace:'aether-tenant-test',scratch,kvStorage:'postgres',assetManifest:{},
      workers:[
        {config:{name:'router',compatibility_date:'2026-09-04',services:[{binding:'BACKEND',service:'workshop-backend'}]},
          modules:[{name:'router.js',esModule:'export default {fetch(req,env){return env.BACKEND.fetch(req)}}'}]},
        {config:{name:'workshop-backend',compatibility_date:'2026-09-04',kv_namespaces:[{binding:'BLUEPRINTS'},{binding:'OTHER'}]},
          modules:[{name:'probe.js',esModule:probe}]},
        ...['gatekeeper-context','gatekeeper-scheduler'].map(name=>({
          config:{name,compatibility_date:'2026-09-04'},
          modules:[{name:'stub.js',esModule:"import {WorkerEntrypoint} from 'cloudflare:workers'; export class GatekeeperVendor extends WorkerEntrypoint {} export default {fetch(){return new Response('stub')}}"}],
        })),
      ],
    });
    const file = join(scratch,'workspace.bin'); await writeFile(file,binary); await mkdir(join(scratch,'assets'));
    const portServer=createServer(); portServer.listen(0,'127.0.0.1'); await once(portServer,'listening');
    const port=portServer.address().port; await new Promise(resolve=>portServer.close(resolve));
    const origin='http://127.0.0.1:'+port;
    const args=['serve',file,'--binary','--experimental','--socket-addr=http=127.0.0.1:'+port,
      '--external-addr=aether:postgres-endpoint=127.0.0.1:'+adapterPort,
      '--directory-path=aether:assets-disk='+join(scratch,'assets')];
    for (const {service,subdirectory} of directories) {
      await mkdir(join(scratch,subdirectory),{recursive:true});
      args.push('--directory-path='+service+'='+join(scratch,subdirectory));
    }
    async function start() {
      output='';
      child=spawn(createRequire(import.meta.url)('workerd').default,args,{stdio:['ignore','pipe','pipe'],env:{...process.env,AETHER_ADMINS:'[]'}});
      child.stdout.on('data',chunk=>{output+=chunk}); child.stderr.on('data',chunk=>{output+=chunk});
      for(let i=0;i<150;i++) {
        try {if((await fetch(origin+'/healthz',{signal:AbortSignal.timeout(250)})).ok) return;} catch {}
        if(child.exitCode !== null) break;
        await delay(20);
      }
      throw new Error('Native KV probe failed to start: '+output);
    }
    async function call(payload,ns='') {
      const result=await fetch(origin+'/op'+(ns?'?ns='+ns:''),{method:'POST',body:JSON.stringify(payload)});
      if(!result.ok) throw new Error('Native KV operation failed: '+result.status);
      return result.json();
    }
    await start();
    await run({origin,call,config,scratch,restart:async()=>{await stop();await start()}});
  } finally {await stop();await rm(scratch,{recursive:true,force:true})}
}
