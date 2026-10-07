import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {newWebSocketRpcSession} from '../../node_modules/capnweb/dist/index.js';
import {createIssuer} from './issuer.mjs';
import {readConfig} from '../config.mjs';
import {createAdapter} from '../server.mjs';

const root = resolve(import.meta.dirname, '../..');

// Real Keycloak authentication uses its browser form and cookies, not a password grant.
async function keycloakLogin(url, username) {
  const cookies = new Map();
  async function request(url, options={}) {
    const response = await fetch(url, {...options, redirect:'manual', headers:{...options.headers,
      cookie:[...cookies].map(([name,value])=>`${name}=${value}`).join('; ')}});
    for (const cookie of response.headers.getSetCookie()) {
      const [name,value] = cookie.split(';',1)[0].split('=');cookies.set(name,value);
    }
    return response;
  }
  let response = await request(url);
  for (let i=0; response.status === 302 && i<10; i++) response = await request(new URL(response.headers.get('location'),url));
  const html = await response.text();
  const action = html.match(/<form[^>]+action="([^"]+)"/i)?.[1]?.replaceAll('&amp;','&');
  assert.ok(action,'Keycloak login form missing');
  response = await request(action,{method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({username,password:'aether-test-secret',credentialId:''})});
  assert.equal(response.status,302,'Keycloak browser login failed');
  return response.headers.get('location');
}

test('native workspace OIDC: browser binding, password denial, signup policy, account isolation and restart',
  {skip:process.env.AETHER_TEST_OIDC_WORKSPACE !== 'true', timeout:60000}, async t => {
  const keycloak = process.env.AETHER_TEST_KEYCLOAK_ISSUER;
  const issuer = keycloak ? null : await createIssuer();
  if (issuer) t.after(()=>issuer.close());
  const origin = 'http://127.0.0.1:8080';
  const config = await readConfig({AETHER_TENANT_ID:'acme',AETHER_PUBLIC_URL:origin,AETHER_OIDC_ISSUER:keycloak || issuer.origin,
    AETHER_OIDC_CLIENT_ID:'aether',AETHER_OIDC_CLIENT_SECRET:'fixture-secret',AETHER_OIDC_ALLOW_HTTP:'true'});
  const adapter = await createAdapter(config); t.after(()=>adapter.close());
  const port = await adapter.listen(0);
  const stateDir = await mkdtemp(join(tmpdir(),'aether-oidc-')); t.after(()=>rm(stateDir,{recursive:true,force:true}));
  let child, logs=''; const sockets=[];
  async function stop() {
    for (const [api, socket] of sockets.splice(0)) {api[Symbol.dispose]();socket.close();}
    if (!child || child.exitCode !== null) return;
    const exited=once(child,'exit');child.kill('SIGTERM');await exited;
  }
  t.after(()=>stop());
  async function start() {
    child=spawn(process.execPath,[join(root,'run-workspace.mjs')], {env:{...process.env,
      AETHER_TENANT_ID:'acme',AETHER_STATE_DIR:stateDir,AETHER_PORT:'8080',AETHER_PUBLIC_URL:origin,AETHER_OIDC_PORT:String(port),
      AETHER_OIDC_ALLOW_HTTP:'true',AETHER_ADMINS:'["admin@example.com"]'},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',v=>logs+=v);child.stderr.on('data',v=>logs+=v);
    for(let i=0;i<200;i++) {
      if(child.exitCode !== null) break;
      try {if((await fetch(origin+'/readyz')).ok)return;} catch{}
      await delay(50);
    }
    throw new Error('Native workspace failed to start: '+logs);
  }
  async function browser() {
    const response=await fetch(origin);
    const cookie=response.headers.getSetCookie()[0]?.split(';')[0];assert.ok(cookie,'Missing browser login cookie');
    const socket=new WebSocket(origin.replace('http:','ws:')+'/api',{headers:{cookie,origin}});
    const api=newWebSocketRpcSession(socket);sockets.push([api,socket]);
    return {api,cookie};
  }
  async function login(browser, username='admin') {
    const attempt=await browser.api.startGatekeeperLogin('oidc');
    const result=attempt.attempt.wait();
    // Attach rejection immediately, including for failure-path tests.
    const outcome=result.then(token=>({token}),error=>({error}));
    const redirect=await fetch(attempt.url,{headers:{cookie:browser.cookie},redirect:'manual'});
    assert.equal(redirect.status,302,logs);
    const authorize=redirect.headers.get('location');
    const callback=keycloak ? await keycloakLogin(authorize,username)
      : (await fetch(authorize,{redirect:'manual'})).headers.get('location');
    const response=await fetch(callback,{headers:{cookie:browser.cookie},redirect:'manual'});
    return {response, callback, outcome:await outcome};
  }
  try {
    await start();const admin=await browser();const other=await browser();
    const server=await admin.api.getServerConfig();
    assert.equal(server.passwordAuthEnabled,false);assert.deepEqual(server.authVendors.map(v=>v.vendorId),['oidc']);
    await assert.rejects(async()=>await admin.api.createAccount('password','Password',new Uint8Array(32)),/disabled/i);
    await assert.rejects(async()=>await admin.api.login('password',new Uint8Array(32)),/disabled/i);
    assert.equal((await fetch(origin+'/api',{method:'POST',body:'[]'})).status,403);
    assert.equal((await fetch(origin+'/api',{method:'POST',headers:{cookie:admin.cookie,origin:'http://evil.invalid'},body:'[]'})).status,403);
    const attack=await admin.api.startGatekeeperLogin('oidc');
    assert.equal((await fetch(attack.url,{headers:{cookie:other.cookie},redirect:'manual'})).status,400);
    assert.equal((await fetch(attack.url,{redirect:'manual'})).status,400);
    const signed=await login(admin);assert.equal(signed.response.status,200,logs);assert.ok(signed.outcome.token,logs);
    const token=signed.outcome.token;
    const user=await admin.api.authenticate(token);assert.equal((await user.whoami()).id,'admin@example.com');
    const adminApi=await user.getAdminApi();assert.ok(adminApi);
    await user.setOwnDisplayName('Persistent OIDC Admin');
    const gadget=await user.newGadget().getMetadata();
    assert.equal((await fetch(signed.callback,{headers:{cookie:admin.cookie}})).status,400);
    if(issuer) issuer.setScenario({claims:{sub:'other-subject',email:'other@example.com'}});
    const signedOther=await login(other,'other');assert.ok(signedOther.outcome.token,logs);
    const otherUser=await other.api.authenticate(signedOther.outcome.token);
    assert.equal(await otherUser.getAdminApi(),null);
    await assert.rejects(async()=>await otherUser.openGadget(gadget.id).getMetadata(),/access|permission|not found/i);
    await adminApi.setSignupsEnabled(false);
    if(issuer) issuer.setScenario({claims:{sub:'new-subject',email:'new@example.com'}});
    const blocked=await login(other,'new');assert.ok(blocked.outcome.error);assert.match(blocked.outcome.error.message,/disabled/i);
    if(issuer) {
      issuer.setScenario({claims:{sub:'hijacker'}});
      const hijack=await login(admin);assert.equal(hijack.response.status,400);assert.ok(hijack.outcome.error);
      issuer.setScenario({});
    }
    await stop();await start();const restored=await browser();
    assert.equal((await restored.api.authenticate(token).whoami()).name,'Persistent OIDC Admin');
    const existing=await login(restored);assert.ok(existing.outcome.token,'Existing user must sign in with signups closed');
    assert.equal((await restored.api.authenticate(existing.outcome.token).openGadget(gadget.id).getMetadata()).id,gadget.id);
    if(issuer) {
      issuer.setScenario({claims:{sub:'hijacker'}});
      assert.equal((await login(restored)).response.status,400,'Identity binding must survive restart');
    }
  } catch(error) {error.message+='\nNative logs:\n'+logs;throw error;}
});
