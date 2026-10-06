import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { createAdapter } from '../server.mjs';
import { nativeHarness } from './native-harness.mjs';
import { setupDatabase } from './database-fixture.mjs';

test('native KV errors propagate and oversize streams never reach PostgreSQL', async () => {
  let puts = 0;
  const backend = createServer((request,response)=>{
    if(request.method==='PUT') puts++;
    request.resume(); response.writeHead(503).end();
  });
  backend.listen(0,'127.0.0.1'); await once(backend,'listening');
  try {
    await nativeHarness(backend.address().port,async({origin,call})=>{
      assert.equal((await fetch(origin+'/readyz')).status,503);
      assert.equal((await fetch(origin+'/healthz')).status,200);
      await assert.rejects(call({action:'get',key:'missing'}));
      await assert.rejects(call({action:'put',key:'failed',value:'must fail'}));
      assert.equal(puts,1);
      const large = Buffer.alloc(26*1024*1024,42);
      const stream = new ReadableStream({start(controller){
        for(let offset=0;offset<large.length;offset+=65536) controller.enqueue(large.subarray(offset,offset+65536));
        controller.close();
      }});
      assert.equal((await fetch(origin+'/bytes?key=oversize',{method:'PUT',body:stream,duplex:'half'})).status,500);
      assert.equal(puts,1,'truncated oversize streams must not be committed');
    });
  } finally {backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));}
});

test('PostgreSQL role isolation and native KV contracts survive runtime restart', {skip:!process.env.AETHER_TEST_PGHOST,timeout:120000}, async()=>{
  const fixture = await setupDatabase(), config = await fixture.config();
  const app = new pg.Pool(config.database);
  let adapter;
  try {
    await assert.rejects(createAdapter({...config,tenantId:'other'}),/identity mismatch/);
    await assert.rejects(createAdapter({...config,database:fixture.adminConfig}),/administrative privileges/);
    await fixture.admin.query('ALTER SCHEMA aether OWNER TO aether_test_app');
    try { await assert.rejects(createAdapter(config),/protected non-owned/); }
    finally { await fixture.admin.query('ALTER SCHEMA aether OWNER TO postgres'); }
    await fixture.admin.query('ALTER DATABASE aether_test OWNER TO aether_test_app');
    try { await assert.rejects(createAdapter(config),/must not own the database/); }
    finally { await fixture.admin.query('ALTER DATABASE aether_test OWNER TO postgres'); }
    await fixture.admin.query('ALTER TABLE aether.kv_entries DISABLE ROW LEVEL SECURITY');
    try { await assert.rejects(createAdapter(config),/protected non-owned/); }
    finally { await fixture.admin.query('ALTER TABLE aether.kv_entries ENABLE ROW LEVEL SECURITY'); }
    await fixture.admin.query("INSERT INTO aether.kv_entries VALUES ('other','aether-tenant-other-workshop-backend-BLUEPRINTS',$1,$2,NULL,NULL)",[Buffer.from('private'),Buffer.from('other value')]);
    assert.equal((await app.query('SELECT * FROM aether.kv_entries')).rowCount,0);
    assert.equal((await app.query('SELECT * FROM aether.tenant_roles')).rowCount,1);
    await assert.rejects(app.query("INSERT INTO aether.kv_entries VALUES ('other','aether-tenant-other-workshop-backend-BLUEPRINTS',$1,$2,NULL,NULL)",[Buffer.from('intrusion'),Buffer.from('bad')]),{code:'42501'});
    assert.equal((await app.query("UPDATE aether.kv_entries SET value=$1 WHERE tenant_id='other'",[Buffer.from('bad')])).rowCount,0);
    assert.equal((await app.query("DELETE FROM aether.kv_entries WHERE tenant_id='other'")).rowCount,0);
    await assert.rejects(app.query("UPDATE aether.tenant_roles SET tenant_id='other'"),{code:'42501'});
    const session=await app.connect();
    try {
      await session.query("SET aether.tenant_id = 'other'");
      await session.query('SET ROLE aether_kv_app');
      assert.equal((await session.query('SELECT * FROM aether.kv_entries')).rowCount,0);
      await session.query('RESET ROLE');
    } finally {session.release();}
    adapter=await createAdapter(config); adapter.listen(0,'127.0.0.1');await once(adapter,'listening');
    await nativeHarness(adapter.address().port,async({origin,call,restart,scratch})=>{
      assert.equal((await fetch(origin+'/readyz')).status,200);
      const missing=await call({action:'get',key:'missing'});
      assert.equal(missing.value,null);assert.equal(missing.metadata,null);
      await call({action:'put',key:'unicode/é/中文',value:'persistent value',options:{metadata:{label:'中文',count:3}}});
      const read=await call({action:'get',key:'unicode/é/中文'});
      assert.equal(read.value,'persistent value');assert.deepEqual(read.metadata,{label:'中文',count:3});
      await call({action:'put',key:'unicode/é/中文',value:'separate namespace'},'other');
      assert.equal((await call({action:'get',key:'unicode/é/中文'},'other')).value,'separate namespace');
      const bytes=Buffer.from([0,1,255,42]);
      assert.equal((await fetch(origin+'/bytes',{method:'PUT',body:bytes})).status,200);
      assert.deepEqual(Buffer.from(await(await fetch(origin+'/bytes')).arrayBuffer()),bytes);
      await call({action:'put',key:'empty',value:''});assert.equal((await call({action:'get',key:'empty'})).value,'');
      await call({action:'put',key:'json',value:JSON.stringify({a:1})});
      assert.deepEqual((await call({action:'get',key:'json',type:'json'})).value,{a:1});
      assert.deepEqual(await call({action:'bulk',keys:['json','missing'],type:'json'}),{json:{a:1},missing:null});
      await call({action:'put',key:'ttl',value:'expiring',options:{expirationTtl:60,metadata:{expires:true}}});
      const expiration=await fixture.admin.query("SELECT expiration FROM aether.kv_entries WHERE tenant_id='test' AND key=$1",[Buffer.from('ttl')]);
      assert.ok(Number(expiration.rows[0].expiration)>Date.now()+50000);
      await fixture.admin.query("UPDATE aether.kv_entries SET expiration=1 WHERE tenant_id='test' AND key=$1",[Buffer.from('ttl')]);
      assert.equal((await call({action:'get',key:'ttl'})).value,null);
      await assert.rejects(call({action:'put',key:'invalid-ttl',value:'bad',options:{expirationTtl:1}}));
      await assert.rejects(call({action:'put',key:'.',value:'bad'}));
      await assert.rejects(call({action:'put',key:'x'.repeat(513),value:'bad'}));
      await assert.rejects(call({action:'put',key:'metadata-too-large',value:'bad',options:{metadata:'x'.repeat(1025)}}));
      const ordered=['prefix/%a','prefix/%b','prefix/_a','prefix/é','prefix/中文'];
      for(const key of ordered)await call({action:'put',key,value:key});
      let keys=[],cursor;
      do {
        const page=await call({action:'list',options:{prefix:'prefix/',limit:2,...(cursor?{cursor}:{})}});
        keys.push(...page.keys.map(key=>key.name));cursor=page.list_complete?undefined:page.cursor;
      } while(cursor);
      assert.deepEqual(keys,ordered);
      const percent=await call({action:'list',options:{prefix:'prefix/%'}});
      assert.deepEqual(percent.keys.map(key=>key.name),ordered.slice(0,2));
      const page=await call({action:'list',options:{prefix:'prefix/',limit:1}});
      await assert.rejects(call({action:'list',options:{prefix:'different/',cursor:page.cursor}}));
      for(const key of ['z','é','中文']) await call({action:'put',key:'parallel/'+key,value:key});
      await Promise.all(Array.from({length:24},(_,i)=>call({action:'put',key:'parallel/key'+i,value:'value'+i})));
      assert.equal((await call({action:'list',options:{prefix:'parallel/'}})).keys.length,27);
      await restart();
      assert.equal((await call({action:'get',key:'unicode/é/中文'})).value,'persistent value');
      assert.deepEqual(Buffer.from(await(await fetch(origin+'/bytes')).arrayBuffer()),bytes);
      await call({action:'delete',key:'json'});await call({action:'delete',key:'json'});
      assert.equal((await call({action:'get',key:'json'})).value,null);
      assert.ok(!(await readdir(join(scratch,'kv'),{recursive:true})).some(path=>path.includes('blobs')));
      const direct='http://127.0.0.1:'+adapter.address().port;
      assert.equal((await fetch(direct+'/entry?key=cHJpdmF0ZQ',{headers:{'X-Aether-Namespace':'aether-tenant-other-workshop-backend-BLUEPRINTS'}})).status,403);
      assert.equal((await fetch(direct+'/list?limit=1001',{headers:{'X-Aether-Namespace':'aether-tenant-test-workshop-backend-BLUEPRINTS'}})).status,400);
      assert.equal((await fetch(direct+'/entry?key=not!base64',{headers:{'X-Aether-Namespace':'aether-tenant-test-workshop-backend-BLUEPRINTS'}})).status,400);
      assert.ok((await app.query('SELECT * FROM aether.kv_entries')).rows.every(row=>row.tenant_id==='test'));
      assert.equal((await fixture.admin.query("SELECT value FROM aether.kv_entries WHERE tenant_id='other'")).rows[0].value.toString(),'other value');
    });
  } finally {
    if(adapter){adapter.closeAllConnections();await new Promise(resolve=>adapter.close(resolve));}
    await app.end();await fixture.admin.end();
  }
});
