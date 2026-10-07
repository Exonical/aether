import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readConfig} from '../config.mjs';
import {createAdapter} from '../server.mjs';
import {createIssuer} from './issuer.mjs';

test('OIDC discovery rejects an untrusted certificate and accepts the configured internal CA',
  {skip:process.platform === 'win32' && spawnSync('openssl',['version']).error?.code === 'ENOENT' ? 'OpenSSL is required for the TLS fixture; CI verifies it on Linux' : false}, async t => {
  const directory = await mkdtemp(join(tmpdir(),'aether-oidc-tls-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const cert=join(directory,'cert.pem'), key=join(directory,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
  const issuer=await createIssuer({cert:await readFile(cert),key:await readFile(key)});t.after(()=>issuer.close());
  const env={AETHER_TENANT_ID:'acme',AETHER_OIDC_ISSUER:issuer.origin,AETHER_PUBLIC_URL:'https://aether.example',
    AETHER_OIDC_CLIENT_ID:'aether',AETHER_OIDC_CLIENT_SECRET:'fixture-secret'};
  await assert.rejects(createAdapter(await readConfig(env)));
  const adapter=await createAdapter(await readConfig({...env,AETHER_OIDC_CA_FILE:cert}));t.after(()=>adapter.close());
  const port=await adapter.listen(0);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status,200);
});
