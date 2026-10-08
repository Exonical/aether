import {createServer, request as httpRequest} from 'node:http';
import {createExecutionFixture} from '../../execution/test/fixture.mjs';
import {createGitBroker} from '../../execution/git-broker.mjs';
import {createGitOAuth} from '../../execution/git-oauth.mjs';
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
  const gitOAuthCalls = [];
  const gitApi = createServer(async (req, res) => {
    if (req.url.startsWith('/oauth/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      gitOAuthCalls.push({path: req.url, form});
      res.setHeader('content-type', 'application/json');
      assert.equal(form.get('client_secret'), 'git-oauth-secret');
      if (req.url === '/oauth/revoke') return res.end('{}');
      assert.ok(form.get('code_verifier'));
      return res.end(JSON.stringify({access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_in: 7200, scope: 'read_user read_repository', token_type: 'bearer'}));
    }
    const valid = ['admin-token', 'other-token'].includes(req.headers['private-token']) || req.headers.authorization === 'Bearer oauth-access';
    res.writeHead(valid ? 200 : 401, {'content-type':'application/json'});
    res.end(JSON.stringify({username:req.headers['private-token'] === 'admin-token' ? 'admin' : 'other'}));
  });
  await new Promise(resolve => gitApi.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{gitApi.close(resolve);gitApi.closeAllConnections();}));
  const gitProviders = [{id:'internal',label:'Internal GitLab',kind:'gitlab',url:'https://git.internal'}];
  const gitRequest = (url, options, callback)=>httpRequest(`http://127.0.0.1:${gitApi.address().port}${url.pathname}`,options,callback);
  const oauth = createGitOAuth({providers:gitProviders,clients:{internal:{clientId:'git-app',clientSecret:'git-oauth-secret'}},publicUrl:'https://aether.internal',request:gitRequest});
  const gitBroker = createGitBroker({providers:gitProviders,oauth,publicUrl:'http://git-broker.invalid/',request:gitRequest});
  const execution = await createExecutionFixture(join(stateDir,'execution'),{gitBroker});
  t.after(()=>execution.close());
  let child, logs=''; const sockets=[];
  async function stop() {
    for (const [api, socket] of sockets.splice(0)) {api[Symbol.dispose]();socket.close();}
    if (!child || child.exitCode !== null) return;
    const exited=once(child,'exit');child.kill('SIGTERM');await exited;
  }
  t.after(()=>stop());
  async function start(departmentsEnabled=true, executionEnabled=true) {
    child=spawn(process.execPath,[join(root,'run-workspace.mjs')], {env:{...process.env,
      AETHER_BIND_ADDRESS:keycloak ? '0.0.0.0':'127.0.0.1',AETHER_TENANT_ID:'acme',AETHER_STATE_DIR:stateDir,AETHER_PORT:'8080',AETHER_PUBLIC_URL:origin,AETHER_OIDC_PORT:String(port),
      AETHER_EXECUTION_ENABLED:String(executionEnabled),AETHER_DEPARTMENTS:String(departmentsEnabled),AETHER_OIDC_ALLOW_HTTP:'true',AETHER_ADMINS:'["admin@example.com"]'},stdio:['ignore','pipe','pipe']});
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
    return {api,cookie,socket};
  }
  async function login(browser, username='admin') {
    const attempt=await browser.api.startGatekeeperLogin('oidc');
    const redirect=await fetch(attempt.url,{headers:{cookie:browser.cookie},redirect:'manual'});
    assert.equal(redirect.status,302,logs);
    const authorize=redirect.headers.get('location');
    const callback=keycloak ? await keycloakLogin(authorize,username)
      : (await fetch(authorize,{redirect:'manual'})).headers.get('location');
    const response=await fetch(callback,{headers:{cookie:browser.cookie},redirect:'manual'});
    if(response.status===302){
      const handoff=new URL(response.headers.get('location'));
      assert.equal(handoff.origin,origin);assert.equal(handoff.pathname,'/connect/handoff');
      let pending;try {pending=await attempt.attempt.receive();} catch(error){return {response,callback,outcome:{error}};}
      assert.equal(pending,null,'Handoff must be confirmed before receiving session');
      await assert.rejects(async()=>await browser.api.confirmLogin(handoff.hash.slice(1),'0'.repeat(64)));
      await browser.api.confirmLogin(handoff.hash.slice(1),attempt.nonce);
    }
    const outcome=await attempt.attempt.receive().then(token=>({token}),error=>({error}));
    return {response, callback, outcome};
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
    const signed=await login(admin);assert.equal(signed.response.status,302,logs);assert.ok(signed.outcome.token,logs);
    const token=signed.outcome.token;
    let user=await admin.api.authenticate(token);assert.equal((await user.whoami()).id,'admin@example.com');
    let adminApi=await user.getAdminApi();assert.ok(adminApi);
    await user.setOwnDisplayName('Persistent OIDC Admin');
    const gadget=await user.newGadget().getMetadata();
    const executionProfile=await user.getExecutionProfile();
    assert.deepEqual(executionProfile.identity,{username:'admin',uid:12345,gid:23456});
    const ownGit=await user.linkGitConnection('internal','admin-token');
    assert.equal(ownGit.login,'admin');
    assert.ok(!JSON.stringify(await user.getExecutionProfile()).includes('admin-token'));
    const workspace=user.openGadget(gadget.id);
    const askChat=await workspace.newChat('General chat',null);
    await assert.rejects(async()=>await workspace.executionWorkspace({action:'start'},askChat),/Agent/i);
    const agentChat=await workspace.newChat('Coding task',null,undefined,undefined,undefined,{mode:'agent',environment:'rhel10'});
    const operation=body=>workspace.executionWorkspace(body,agentChat);
    assert.equal((await operation({action:'start'})).state,'ready');
    const pod=execution.calls.find(call=>call.body?.kind==='Pod').body;
    assert.deepEqual(pod.spec.containers[0].env,[{name:'AETHER_EXECUTION_USERNAME',value:'admin'},{name:'AETHER_EXECUTION_UID',value:'12345'},{name:'AETHER_EXECUTION_GID',value:'23456'}]);
    assert.equal((await operation({action:'exec',command:'git init -q && printf initial > README.md && git add . && git -c user.name=Fixture -c user.email=fixture@example.com commit -qm initial'})).exitCode,0);
    await operation({action:'write',path:'README.md',content:'agent workspace\n'});
    await assert.rejects(async()=>await workspace.sendChatMessage(agentChat,'Wrong repository',null,undefined,undefined,undefined,
      {mode:'agent',environment:'rhel10',git:{connectionId:ownGit.id,repository:'team/another'}}),/new chat/i);
    await operation({action:'suspend'});
    await assert.rejects(async()=>await operation({action:'read',path:'README.md'}),/start/i);
    await operation({action:'start'});
    assert.equal((await operation({action:'read',path:'README.md'})).content,'agent workspace\n');
    await workspace.sendChatMessage(agentChat,'Back to chat',null,undefined,undefined,undefined,{mode:'ask',environment:'rhel10'});
    await assert.rejects(async()=>await operation({action:'exec',command:'echo denied'}),/Agent/i);
    const disabledChat=await workspace.newChat('Agent selected before administrative disable',null,undefined,undefined,undefined,{mode:'agent',environment:'rhel10'});
    await stop();await start(true,false);
    Object.assign(admin,await browser());Object.assign(other,await browser());
    user=await admin.api.authenticate(token);adminApi=await user.getAdminApi();
    assert.equal((await user.getExecutionProfile()).enabled,false);
    const callsBeforeAsk=execution.calls.length;
    await user.openGadget(gadget.id).sendChatMessage(disabledChat,'Ask still works',null,undefined,undefined,undefined,{mode:'ask',environment:'rhel10'});
    assert.equal(execution.calls.length,callsBeforeAsk,'Ask must not contact Kubernetes when execution is disabled');
    await stop();await start();
    Object.assign(admin,await browser());Object.assign(other,await browser());
    user=await admin.api.authenticate(token);adminApi=await user.getAdminApi();
    assert.equal((await fetch(signed.callback,{headers:{cookie:admin.cookie}})).status,400);
    if(issuer) issuer.setScenario({claims:{sub:'other-subject',email:'other@example.com',preferred_username:'other',uidNumber:12346}});
    const signedOther=await login(other,'other');assert.ok(signedOther.outcome.token,logs);
    let otherUser=await other.api.authenticate(signedOther.outcome.token);
    assert.equal(await otherUser.getAdminApi(),null);
    assert.deepEqual((await otherUser.getExecutionProfile()).connections,[]);
    const otherWorkspace=await otherUser.newGadget().getMetadata();
    await assert.rejects(async()=>await otherUser.openGadget(otherWorkspace.id).newChat('Cannot borrow account',null,undefined,undefined,undefined,
      {mode:'agent',environment:'rhel10',git:{connectionId:ownGit.id,repository:'team/project'}}),/own linked/i);
    const otherGit=await otherUser.linkGitConnection('internal','other-token');
    const gitFlow=await user.beginGitOAuth('internal');
    assert.equal(new URL(gitFlow.url).origin,'https://git.internal');
    assert.equal(JSON.stringify(gitFlow).includes('git-oauth-secret'),false);
    assert.deepEqual(Object.keys(gitFlow).toSorted(),['state','url']);
    await assert.rejects(async()=>await otherUser.completeGitOAuth(gitFlow.state,'code'),/expired/i);
    const oauthGit=await user.completeGitOAuth(gitFlow.state,'code');
    await assert.rejects(async()=>await user.completeGitOAuth(gitFlow.state,'code'),/expired/i);
    assert.equal(JSON.stringify(await user.getExecutionProfile()).includes('oauth-access'),false);
    assert.equal(JSON.stringify(await user.getExecutionProfile()).includes('oauth-refresh'),false);
    await assert.rejects(async()=>await otherUser.removeGitConnection(oauthGit.id),/No such/i);
    await user.removeGitConnection(oauthGit.id);
    assert.equal(gitOAuthCalls.find(call=>call.path==='/oauth/revoke').form.get('token'),'oauth-access');
    await assert.rejects(async()=>await otherUser.removeGitConnection(ownGit.id),/No such/i);
    await user.removeGitConnection(ownGit.id);
    assert.deepEqual((await user.getExecutionProfile()).connections,[]);
    assert.deepEqual((await otherUser.getExecutionProfile()).connections,[otherGit]);
    await assert.rejects(async()=>await otherUser.openGadget(gadget.id).getMetadata(),/access|permission|not found/i);
    const departments = async (client, token, body, expected=200) => {
      const response=await fetch(origin+'/api/departments',{method:body?'POST':'GET',headers:{cookie:client.cookie,origin,
        authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
      assert.equal(response.status,expected,await response.clone().text());
      const data=await response.json();
      if(response.ok && body && !['audit','rename'].includes(body.action)){
        // Membership edits invalidate old RPC connections; browser clients reconnect with saved tokens.
        Object.assign(admin,await browser());user=await admin.api.authenticate(token);adminApi=await user.getAdminApi();
        Object.assign(other,await browser());otherUser=await other.api.authenticate(signedOther.outcome.token);
      }
      return data;
    };
    assert.equal((await fetch(origin+'/departments')).status,200);
    assert.match(await (await fetch(origin)).text(),/href="\/departments"/);
    await departments(admin,token,{action:'create',department:'engineering',name:'Engineering'});
    await departments(admin,token,{action:'create',department:'finance',name:'Finance'});
    if(issuer){
      config.departmentClaim='groups';config.departmentMapping={'/Engineering':'engineering','/Finance':'finance'};
      issuer.setScenario({claims:{sub:'other-subject',email:'other@example.com',preferred_username:'other',uidNumber:12346,groups:['/Engineering','admin']}});
      const mappedBrowser=await browser();const mapped=await login(mappedBrowser,'other');assert.ok(mapped.outcome.token);
      const membership=await departments(mappedBrowser,mapped.outcome.token);
      assert.deepEqual(membership.departments.map(d=>d.id),['engineering']);
      assert.equal(membership.departments[0].canManage,false,'Signed groups must never grant admin');
      issuer.setScenario({claims:{sub:'other-subject',email:'other@example.com',preferred_username:'other',uidNumber:12346,groups:[]}});
      const removedBrowser=await browser();const removed=await login(removedBrowser,'other');assert.deepEqual((await departments(removedBrowser,removed.outcome.token)).departments,[]);
      config.departmentClaim=undefined;config.departmentMapping={};
    }
    await departments(admin,token,{action:'setMember',department:'engineering',email:'other@example.com',role:'admin'});
    assert.deepEqual((await departments(other,signedOther.outcome.token)).departments.map(d=>d.id),['engineering']);
    const relogged=await login(other,'other');assert.ok(relogged.outcome.token);
    assert.equal((await departments(other,relogged.outcome.token)).departments[0].canManage,true,'Manual admin grant survives login synchronization');
    await departments(other,signedOther.outcome.token,{action:'create',department:'shadow',name:'Shadow'},403);
    await departments(other,signedOther.outcome.token,{action:'setMember',department:'finance',email:'member@example.com',role:'member'},403);
    await departments(other,signedOther.outcome.token,{action:'setMember',department:'engineering',email:'member@example.com',role:'admin'},403);
    await departments(other,signedOther.outcome.token,{action:'setMember',department:'engineering',email:'member@example.com',role:'member'});
    await departments(admin,token,{action:'removeMember',department:'engineering',email:'other@example.com'});
    await departments(other,signedOther.outcome.token,{action:'setMember',department:'engineering',email:'member@example.com',role:'member'},403);
    assert.deepEqual((await departments(other,signedOther.outcome.token)).departments,[]);
    // Share-link and direct collaborator grants cannot cross departmental boundaries.
    await departments(admin,token,{action:'setMember',department:'engineering',email:'admin@example.com',role:'member'});
    await departments(admin,token,{action:'setMember',department:'finance',email:'other@example.com',role:'member'});
    const share=await user.openGadget(gadget.id).createShareLink('build');
    await assert.rejects(async()=>await otherUser.openGadget(gadget.id,share.key).getMetadata(),/denied|access|permission/i);
    await assert.rejects(async()=>await user.openGadget(gadget.id).addCollaborator('other@example.com','build'),/denied|access|permission/i);
    await departments(admin,token,{action:'setMember',department:'engineering',email:'other@example.com',role:'member'});
    const formerlyShared=await otherUser.openGadget(gadget.id,share.key);
    assert.equal((await formerlyShared.getMetadata()).id,gadget.id);
    await departments(admin,token,{action:'removeMember',department:'engineering',email:'other@example.com'});
    await assert.rejects(async()=>await formerlyShared.getMetadata(),'Previously acquired capability must fail after membership edit');
    await assert.rejects(async()=>await otherUser.openGadget(gadget.id).getMetadata(),/denied|access|permission/i);
    await assert.rejects(async()=>await otherUser.openGadget(gadget.id,share.key).getMetadata(),/denied|access|permission/i);
    const financeWorkspace=await otherUser.newGadget().getMetadata();
    const financeLink=await otherUser.openGadget(financeWorkspace.id).createShareLink('build');
    await assert.rejects(async()=>await user.openGadget(financeWorkspace.id,financeLink.key).getMetadata(),/denied|access|permission/i,'Global admin must not bypass department sharing');
    await departments(other,signedOther.outcome.token,{action:'audit'},403);
    assert.ok((await departments(admin,token,{action:'audit'})).some(e=>e.action==='removeMember'));
    await departments(admin,token+'forged',null,401);
    assert.equal((await fetch(origin+'/api/departments',{headers:{cookie:admin.cookie,origin:'https://evil.invalid',authorization:'Bearer '+token}})).status,403);
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
    assert.equal((await departments(restored,token)).departments.length,2,'Department directory persists across restart');
    const existing=await login(restored);assert.ok(existing.outcome.token,'Existing user must sign in with signups closed');
    assert.equal((await restored.api.authenticate(existing.outcome.token).openGadget(gadget.id).getMetadata()).id,gadget.id);
    if(issuer) {
      issuer.setScenario({claims:{sub:'hijacker'}});
      assert.equal((await login(restored)).response.status,400,'Identity binding must survive restart');
    }
    if(keycloak) {
      const live=await browser();const real=await login(live);const active=await live.api.authenticate(real.outcome.token);
      const adminCapability=await active.getAdminApi();const gadgetCapability=await active.openGadget(gadget.id);
      const managementOrigin=new URL(keycloak).origin;
      const response=await fetch(managementOrigin+'/realms/master/protocol/openid-connect/token',{method:'POST',
        headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'admin-cli',grant_type:'password',
          username:'aether-admin',password:'fixture-admin-secret'})});
      assert.equal(response.status,200,'Synthetic Keycloak management login failed');
      const {access_token}=await response.json();const headers={authorization:'Bearer '+access_token};
      const users=await (await fetch(managementOrigin+'/admin/realms/aether/users?username=admin&exact=true',{headers})).json();
      assert.equal(users.length,1);
      const idleClosed=once(live.socket,'close');
      const revoked=await fetch(managementOrigin+'/admin/realms/aether/users/'+users[0].id+'/logout',{method:'POST',headers});
      assert.equal(revoked.status,204,'Keycloak admin logout failed');
      await Promise.race([idleClosed,delay(2000).then(()=>{throw new Error('Keycloak logout did not close the idle session');})]);
      // Keycloak sends the real signed token to the registered native public endpoint.
      await assert.rejects(async()=>await active.whoami());
      await assert.rejects(async()=>await adminCapability.getSettings());
      await assert.rejects(async()=>await gadgetCapability.getMetadata());
      const retry=await browser();await assert.rejects(async()=>await retry.api.authenticate(real.outcome.token));
      assert.equal((await retry.api.authenticate(signedOther.outcome.token).whoami()).id,'other@example.com','Another subject remains signed in');
      await stop();await start();const restarted=await browser();
      await assert.rejects(async()=>await restarted.api.authenticate(real.outcome.token));
    }
    if(issuer) {
      issuer.setScenario({});
      const live=await browser();const sibling=await browser();
      issuer.setScenario({claims:{sid:'logout-session'}});
      const logged=await login(live);const active=await live.api.authenticate(logged.outcome.token);
      const adminCapability=await active.getAdminApi();const gadgetCapability=await active.openGadget(gadget.id);
      issuer.setScenario({claims:{sid:'other-session'}});
      const siblingLogin=await login(sibling);const siblingUser=await sibling.api.authenticate(siblingLogin.outcome.token);
      const logoutUrl=origin+'/gatekeeper/oidc/backchannel-logout';
      const sendLogout=async jwt=>fetch(logoutUrl,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',host:'idp-callback.internal:8080'},body:new URLSearchParams({logout_token:jwt})});
      assert.equal((await sendLogout(await issuer.signLogout({sid:'logout-session'},true))).status,400);
      assert.equal((await active.whoami()).id,'admin@example.com','Invalid logout must not revoke');
      const idleClosed=once(live.socket,'close');
      const logout=await issuer.signLogout({sid:'logout-session',sub:undefined});
      assert.equal((await sendLogout(logout)).status,200);
      await Promise.race([idleClosed,delay(2000).then(()=>{throw new Error('Idle revoked connection did not close');})]);
      await assert.rejects(async()=>await active.whoami());
      await assert.rejects(async()=>await adminCapability.getSettings());
      await assert.rejects(async()=>await gadgetCapability.getMetadata());
      assert.equal((await siblingUser.whoami()).id,'admin@example.com','Different sid stays authenticated');
      const retry=await browser();await assert.rejects(async()=>await retry.api.authenticate(logged.outcome.token));
      await departments(retry,logged.outcome.token,null,401);
      assert.equal((await sendLogout(logout)).status,200,'Duplicate notification is idempotent');
      await stop();await start();const afterLogout=await browser();
      await assert.rejects(async()=>await afterLogout.api.authenticate(logged.outcome.token),'Revocation must survive restart');
      assert.equal((await afterLogout.api.authenticate(siblingLogin.outcome.token).whoami()).id,'admin@example.com');
      const everyone=await issuer.signLogout({sid:undefined});
      assert.equal((await sendLogout(everyone)).status,200);
      await assert.rejects(async()=>await afterLogout.api.authenticate(siblingLogin.outcome.token));
      const separateUser=await browser();
      assert.equal((await separateUser.api.authenticate(signedOther.outcome.token).whoami()).id,'other@example.com','Subject logout must not revoke another account');
      issuer.setScenario({claims:{sid:'logout-session'}});
      const raced=await login(await browser());assert.ok(raced.outcome.error,'Logged-out sid cannot create a session');
      await delay(1100);issuer.setScenario({claims:{sid:'fresh-session'}});
      const freshBrowser=await browser();const fresh=await login(freshBrowser);assert.ok(fresh.outcome.token,'A fresh IdP login should work');
      const freshUser=await freshBrowser.api.authenticate(fresh.outcome.token);
      assert.equal((await sendLogout(everyone)).status,200);
      assert.equal((await freshUser.whoami()).id,'admin@example.com','Replay must not revoke a later session');

    }

    await stop();await start(false);
    assert.equal((await fetch(origin+'/departments')).status,404,'Disabled department UI is unavailable');
  } catch(error) {error.message+='\nNative logs:\n'+logs;throw error;}
});
