export {SessionRegistry, OidcSessions} from './oidc-sessions.js';
import { DurableObject, WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { browserCookie, randomNonce } from './oidc-browser.js';

const TTL = 5 * 60 * 1000;
const STATE = /^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/;
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
  .map(v => v.toString(16).padStart(2, '0')).join('');
const description = env => ({displayName:env.DISPLAY_NAME, url:env.PUBLIC_URL, providesAuth:true});
class VerifiedAccount extends RpcTarget {
  #email; #identity;
  constructor(email,identity=null) {super(); this.#email = email; this.#identity=identity;}
  getOidcIdentity() {return this.#identity;}
  getAuthenticatedEmail() {return this.#email;}
}
class BrowserVendor extends RpcTarget {
  #env; #ctx; #browser;
  constructor(env, ctx, browser) {super(); this.#env = env; this.#ctx = ctx; this.#browser = browser;}
  describe() {return description(this.#env);}
  getSupportedResources() {return [];}
  getTypeScriptTypes() {return '';}
  async connectAccount(callback, options) {
    if (options?.scopes !== 'auth') throw new Error('OIDC is sign-in only');
    const id = this.#ctx.exports.OidcLogin.newUniqueId();
    const secret = randomNonce();
    await this.#ctx.exports.OidcLogin.get(id).initialize(callback, await digest(this.#browser), secret);
    return {url:`${this.#env.PUBLIC_URL}/gatekeeper/oidc/start?state=${id}.${secret}`};
  }
}
export class GatekeeperVendor extends WorkerEntrypoint {
  describe() {return description(this.env);}
  getSupportedResources() {return [];}
  getTypeScriptTypes() {return '';}
  forBrowser(browser) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(browser)) throw new Error('Invalid browser');
    return new BrowserVendor(this.env, this.ctx, browser);
  }
  connectAccount() {throw new Error('Browser-bound login required');}
}

/** First successful login permanently binds a verified email to its issuer and subject. */
export class OidcIdentity extends DurableObject {
  bind(issuer, subject) {
    const existing = this.ctx.storage.kv.get('identity');
    if (existing && (existing.issuer !== issuer || existing.subject !== subject)) throw new Error('Identity reassignment denied');
    if (!existing) this.ctx.storage.kv.put('identity', {issuer, subject});
  }
}
export class OidcLogin extends DurableObject {
  initialize(callback, browserHash, secret) {
    this.ctx.storage.kv.put('callback', callback);
    this.ctx.storage.kv.put('login', {browserHash, secret, expires:Date.now() + TTL, stage:'initial'});
    this.ctx.storage.setAlarm(Date.now() + TTL);
  }
  async alarm() {
    const callback = this.ctx.storage.kv.get('callback');
    this.ctx.storage.kv.delete('callback'); this.ctx.storage.kv.delete('login');
    if (callback) try {await callback.complete(new VerifiedAccount(null));} catch { /* abandoned browser */ }
  }
  async handle(stage, browserHash, secret, callbackUrl) {
    const login = this.ctx.storage.kv.get('login');
    if (!login || login.expires <= Date.now() || login.browserHash !== browserHash || login.secret !== secret
        || login.stage !== (stage === 'start' ? 'initial' : 'redirected')) throw new Error('Invalid or expired login');
    const state = `${this.ctx.id}.${secret}`;
    login.stage = stage === 'start' ? 'redirected' : 'consumed';
    this.ctx.storage.kv.put('login', login); // Change before network I/O, rejecting concurrent/replayed callbacks.
    const callback = this.ctx.storage.kv.get('callback');
    try {
      const response = await this.env.ADAPTER.fetch(`http://oidc/${stage === 'start' ? 'begin' : 'complete'}`, {
        method:'POST', headers:{'content-type':'application/json', 'x-aether-oidc-tenant':this.env.TENANT},
        body:JSON.stringify({state, ...(callbackUrl ? {callback:callbackUrl} : {})})});
      if (!response.ok) throw new Error('OIDC rejected login');
      const result = await response.json();
      if (stage === 'start') return result.url;
      const identity = this.ctx.exports.OidcIdentity.get(this.ctx.exports.OidcIdentity.idFromName(result.email));
      await identity.bind(result.issuer, result.subject);
      const handoff=await callback.complete(new VerifiedAccount(result.email, result));
      if(handoff.targetOrigin !== new URL(this.env.PUBLIC_URL).origin || !/^[a-f0-9]{64}$/.test(handoff.ticket))throw new Error('Invalid login handoff');
      return `${handoff.targetOrigin}/connect/handoff#${handoff.ticket}`;
    } catch {
      await callback.complete(new VerifiedAccount(null));
      throw new Error('OIDC sign-in failed');
    } finally {
      if (stage !== 'start') {
        this.ctx.storage.kv.delete('callback'); this.ctx.storage.kv.delete('login');
        await this.ctx.storage.deleteAlarm();
      }
    }
  }
}
const popup = (ok, status) => new Response(ok
  ? '<!doctype html><title>Sign-in complete</title><p>You can close this window.</p><script>window.close()</script>'
  : '<!doctype html><title>Sign-in failed</title><p>Sign-in failed or expired. Close this window and try again.</p>',
  {status, headers:{'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'referrer-policy':'no-referrer',
    'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'none'"}});
export default {
  async fetch(request, env, ctx) {
    const isLogout=new URL(request.url).pathname === '/gatekeeper/oidc/backchannel-logout';
    try {
      const url = new URL(request.url);
      if (url.pathname === '/gatekeeper/oidc/backchannel-logout') {
        if(request.method!=='POST' || !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.headers.get('content-type') || ''))
          return new Response(null,{status:400});
        const reader=request.body?.getReader();if(!reader)return new Response(null,{status:400});
        let size=0;const chunks=[];
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();return new Response(null,{status:413});}chunks.push(value);}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        const params=new URLSearchParams(new TextDecoder().decode(bytes));
        if(params.getAll('logout_token').length!==1)return new Response(null,{status:400});
        const verified=await env.ADAPTER.fetch('http://oidc/verify-logout',{method:'POST',
          headers:{'content-type':'application/json','x-aether-oidc-tenant':env.TENANT},body:JSON.stringify({logoutToken:params.get('logout_token')})});
        if(!verified.ok)return new Response(null,{status:verified.status===429 || verified.status>=500 ? 503:400});
        await ctx.exports.OidcSessions.getByName('sessions').revoke(await verified.json());
        return new Response(null,{status:200,headers:{'cache-control':'no-store'}});
      }
      if (request.method !== 'GET'  || !['/gatekeeper/oidc/start', '/gatekeeper/oidc/oauth'].includes(url.pathname)) return popup(false, 404);
      const state = url.searchParams.get('state');
      const browser = browserCookie(request, env.PUBLIC_URL);
      if (!browser || !STATE.test(state || '') || url.searchParams.getAll('state').length !== 1) return popup(false, 400);
      const [id, secret] = state.split('.');
      const login = ctx.exports.OidcLogin.get(ctx.exports.OidcLogin.idFromString(id));
      const callback = new URL('/gatekeeper/oidc/oauth', env.PUBLIC_URL);
      callback.search = url.search;
      const redirect = await login.handle(url.pathname.endsWith('/start') ? 'start' : 'complete', await digest(browser), secret, callback.href);
      return redirect ? new Response(null, {status:302, headers:{location:redirect, 'cache-control':'no-store', 'referrer-policy':'no-referrer'}}) : popup(true, 200);
    } catch { return isLogout ? new Response(null,{status:503}):popup(false,400); }
  }
};
