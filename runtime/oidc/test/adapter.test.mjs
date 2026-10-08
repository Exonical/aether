import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {readConfig} from '../config.mjs';
import {createAdapter} from '../server.mjs';
import {createIssuer} from './issuer.mjs';

const base = {AETHER_TENANT_ID:'acme', AETHER_OIDC_ISSUER:'https://identity.example/realm', AETHER_PUBLIC_URL:'https://aether.example',
  AETHER_OIDC_CLIENT_ID:'aether', AETHER_OIDC_CLIENT_SECRET:'fixture-secret'};
test('configuration requires HTTPS, a confidential client, asymmetric signatures and explicit tenant', async () => {
  for (const change of [{AETHER_TENANT_ID:''}, {AETHER_OIDC_CLIENT_SECRET:''}, {AETHER_OIDC_ISSUER:'http://identity.example'},
    {AETHER_PUBLIC_URL:'https://aether.example/subpath'}, {AETHER_OIDC_SIGNING_ALG:'HS256'}, {AETHER_OIDC_REQUIRED_CLAIM:'groups'}])
    await assert.rejects(readConfig({...base,...change}));
  assert.equal((await readConfig(base)).redirectUri,'https://aether.example/gatekeeper/oidc/oauth');
});

test('signed OIDC code flow rejects forged, replayed, unverified and cross-tenant identities', async t => {
  const issuer = await createIssuer();t.after(()=>issuer.close());
  const config = await readConfig({...base,AETHER_OIDC_ISSUER:issuer.origin,AETHER_PUBLIC_URL:'http://127.0.0.1:8080',AETHER_OIDC_ALLOW_HTTP:'true'});
  const adapter = await createAdapter(config);t.after(()=>adapter.close());
  const port = await adapter.listen(0);
  const post = async (path, data, tenant='acme') => fetch(`http://127.0.0.1:${port}${path}`, {method:'POST',
    headers:{'content-type':'application/json','x-aether-oidc-tenant':tenant},body:JSON.stringify(data)});
  async function begin(tamper=false) {
    const state = randomBytes(32).toString('hex')+'.'+randomBytes(32).toString('base64url');
    const response = await post('/begin',{state});assert.equal(response.status,200);
    const {url} = await response.json();
    const auth = new URL(url);assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('scope'),'openid email profile');
    if (tamper) auth.searchParams.set('code_challenge','wrong');
    const redirect = await fetch(auth,{redirect:'manual'});
    return {state,callback:redirect.headers.get('location')};
  }
  const success = await begin();
  const identity=await (await post('/complete',success)).json();
  assert.equal(identity.email,'admin@example.com');assert.equal(identity.subject,'user-1');assert.equal(identity.issuer,issuer.origin);
  assert.deepEqual(identity.posix,{username:'admin',uid:12345,gid:23456});
  assert.equal(identity.sid,'session-1');assert.equal(typeof identity.issuedAt,'number');
  assert.equal((await post('/complete',success)).status,400);
  for (const scenario of [{rogue:true}, {claims:{iss:'https://other.invalid'}}, {claims:{aud:'another-tenant'}},
    {claims:{nonce:'wrong'}}, {claims:{exp:1}}, {claims:{email_verified:false}}, {claims:{email_verified:'true'}},
    {claims:{email:'user:unsafe@example.com'}}, {claims:{email:'user\u0000@example.com'}}, {claims:{email:null}}]) {
    issuer.setScenario(scenario);
    assert.equal((await post('/complete',await begin())).status,400,JSON.stringify(scenario));
  }
  issuer.setScenario({});
  const mismatch = await begin();
  assert.equal((await post('/complete',mismatch,'other')).status,403);
  assert.equal((await post('/complete',{...mismatch,callback:mismatch.callback.replace('8080','8081')})).status,400);
  assert.equal((await post('/complete',mismatch)).status,400);
  const changedState = await begin();
  assert.equal((await post('/complete',{...changedState,callback:changedState.callback.replace(changedState.state,'wrong')})).status,400);
  assert.equal((await post('/complete',await begin(true))).status,400,'Provider must enforce PKCE');
  const expired = await begin();
  const clock = Date.now;
  try {
    Date.now = () => clock() + 6 * 60 * 1000;
    assert.equal((await post('/complete',expired)).status,400,'Pending login expires');
  } finally {Date.now = clock;}
  const another = await begin();
  const concurrent = await Promise.all([post('/complete',another),post('/complete',another)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,400]);
  assert.equal((await post('/begin',{state:'bad'})).status,400);
  assert.equal((await post('/proxy',{state:another.state})).status,404);
});

test('discovery cannot broaden outbound destinations or drop PKCE; signed membership is optional', async t => {
  const issuer = await createIssuer();t.after(()=>issuer.close());
  const env = {...base,AETHER_OIDC_ISSUER:issuer.origin,AETHER_OIDC_ALLOW_HTTP:'true'};
  for (const metadata of [{issuer:'https://other.invalid'}, {token_endpoint:'https://other.invalid/token'}, {code_challenge_methods_supported:['plain']}]) {
    issuer.setScenario({metadata});await assert.rejects(createAdapter(await readConfig(env)));
  }
  issuer.setScenario({claims:{groups:['tenant-other']}});
  const adapter = await createAdapter(await readConfig({...env,AETHER_OIDC_REQUIRED_CLAIM:'groups',AETHER_OIDC_REQUIRED_VALUE:'tenant-acme'}));
  t.after(()=>adapter.close());const port=await adapter.listen(0);
  const post=async(path,body)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json','x-aether-oidc-tenant':'acme'},body:JSON.stringify(body)});
  for (const [groups,status] of [[['tenant-other'],400],[['tenant-acme'],200]]) {
    issuer.setScenario({claims:{groups}});
    const state=randomBytes(32).toString('hex')+'.'+randomBytes(32).toString('base64url');
    const {url}=await (await post('/begin',{state})).json();const redirect=await fetch(url,{redirect:'manual'});
    assert.equal((await post('/complete',{state,callback:redirect.headers.get('location')})).status,status);
  }
});

test('back-channel logout validates signatures, audience, event, time and token type independently of ID tokens',async t=>{
  const issuer=await createIssuer();t.after(()=>issuer.close());
  const adapter=await createAdapter(await readConfig({...base,AETHER_OIDC_ISSUER:issuer.origin,AETHER_OIDC_ALLOW_HTTP:'true'}));t.after(()=>adapter.close());
  const port=await adapter.listen(0);
  const verify=async(logoutToken,tenant='acme')=>fetch(`http://127.0.0.1:${port}/verify-logout`,{method:'POST',
    headers:{'content-type':'application/json','x-aether-oidc-tenant':tenant},body:JSON.stringify({logoutToken})});
  assert.equal((await verify(await issuer.signLogout())).status,200);
  assert.equal((await verify(await issuer.signLogout({sub:undefined}))).status,200,'sid-only logout');
  assert.equal((await verify(await issuer.signLogout({sid:undefined}))).status,200,'subject-wide logout');
  assert.equal((await verify(await issuer.signLogout({exp:undefined}))).status,200,'original standard permits no exp; iat is bounded');
  assert.equal((await verify(await issuer.signLogout({},true))).status,400);
  assert.equal((await verify(await issuer.signLogout(),'other')).status,403);
  for(const claims of [{iss:'https://other.invalid'},{aud:'another-client'},{events:{}},{events:{'http://schemas.openid.net/event/backchannel-logout':[]}},
    {nonce:'ID-token-nonce'},{iat:1},{iat:Math.floor(Date.now()/1000)+60},{exp:1},{jti:''},{sub:undefined,sid:undefined}])
    assert.equal((await verify(await issuer.signLogout(claims))).status,400,JSON.stringify(claims));
});


test('department mapping uses only signed group claims and cannot grant administrator roles', async t => {
  for(const change of [{AETHER_OIDC_DEPARTMENT_MAPPING:'{"engineering":"eng"}'},
    {AETHER_OIDC_DEPARTMENT_CLAIM:'groups',AETHER_OIDC_DEPARTMENT_MAPPING:'{"engineering":"Bad ID"}'}])
    await assert.rejects(readConfig({...base,...change}));
  const issuer=await createIssuer();t.after(()=>issuer.close());
  const adapter=await createAdapter(await readConfig({...base,AETHER_OIDC_ISSUER:issuer.origin,AETHER_PUBLIC_URL:'http://127.0.0.1:8080',
    AETHER_OIDC_ALLOW_HTTP:'true',AETHER_OIDC_DEPARTMENT_CLAIM:'groups',AETHER_OIDC_DEPARTMENT_MAPPING:'{"/Engineering":"engineering","/Finance":"finance"}'}));
  t.after(()=>adapter.close());const port=await adapter.listen(0);
  const post=(path,body)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json','x-aether-oidc-tenant':'acme'},body:JSON.stringify(body)});
  for(const [claims,status,expected] of [[{groups:['/Engineering','/Engineering','unmapped','admin']},200,['engineering']],
    [{groups:[]},200,[]],[{groups:'admin'},400],[{groups:[1]},400]]) {
    issuer.setScenario({claims});
    const state=randomBytes(32).toString('hex')+'.'+randomBytes(32).toString('base64url');
    const {url}=await (await post('/begin',{state})).json();
    const callback=(await fetch(url,{redirect:'manual'})).headers.get('location');
    const response=await post('/complete',{state,callback});assert.equal(response.status,status);
    if(status===200)assert.deepEqual((await response.json()).departments,expected);
  }
});
