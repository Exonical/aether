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
