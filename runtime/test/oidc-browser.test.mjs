import assert from 'node:assert/strict';
import test from 'node:test';
import {browserCookie, oidcSessionExpired} from '../src/oidc-browser.js';

test('OIDC cookies reject duplicates and use the secure host cookie for HTTPS',()=>{
  const nonce='a'.repeat(43);
  assert.equal(browserCookie(new Request('https://aether.example',{headers:{cookie:`__Host-aether-login=${nonce}`}}),'https://aether.example'),nonce);
  for(const cookie of [`aether-login-dev=${nonce}`,`__Host-aether-login=${nonce}; __Host-aether-login=${nonce}`,'__Host-aether-login=bad'])
    assert.equal(browserCookie(new Request('https://aether.example',{headers:{cookie}}),'https://aether.example'),null);
});
test('OIDC session expiry fails closed for missing or invalid lifetime and persisted session dates',()=>{
  const env={AETHER_OIDC_SESSION_TTL:'60'};
  assert.equal(oidcSessionExpired({created:new Date()},env),false);
  assert.equal(oidcSessionExpired({created:new Date(Date.now()-61000)},env),true);
  assert.equal(oidcSessionExpired(null,env),true);
  for(const lifetime of [undefined,'bad','0','86401']) assert.equal(oidcSessionExpired({created:new Date()},{AETHER_OIDC_SESSION_TTL:lifetime}),true);
  assert.equal(oidcSessionExpired({created:'2026-01-01'},env),true);
});

test('department membership changes block both incoming RPC and outgoing subscription messages', async () => {
  const {attachOidcSessionGuard,authenticateOidcSession,guardOidcWebSocket}=await import('../src/oidc-browser.js');
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  for(const direction of ['incoming','outgoing']) {
    let version=1, resolveWatcher, aborted=0, dispatched=0;
    const sent=[];
    const socket=new EventTarget();socket.readyState=1;socket.send=value=>sent.push(value);
    socket.close=()=>{socket.readyState=3;socket.dispatchEvent(new Event('close'));};
    const registry={authenticate:async()=> 'session-hash',accessVersion:async()=>version,
      check:async(id,expected)=>{assert.equal(id,'session-hash');if(expected!==version)throw Error('Access changed');},
      watch:()=>new Promise(resolve=>{resolveWatcher=resolve;}),unwatch:async()=>resolveWatcher?.('disconnected')};
    const tasks=[];
    const api=attachOidcSessionGuard({}, {OIDC_SESSIONS:registry}, {waitUntil:promise=>tasks.push(promise)}, ()=>{aborted++;socket.close();});
    const guarded=guardOidcWebSocket(socket,api);
    guarded.addEventListener('message',()=>dispatched++);
    await authenticateOidcSession(api,'opaque-token');await flush();
    guarded.send('authorized');await flush();assert.deepEqual(sent,['authorized']);
    version++;
    if(direction==='incoming')socket.dispatchEvent(new MessageEvent('message',{data:'stale capability call'}));
    else guarded.send('stale subscription update');
    await flush();await flush();
    assert.equal(dispatched,0);assert.deepEqual(sent,['authorized']);assert.ok(aborted>0);
    await Promise.all(tasks);
  }
});
