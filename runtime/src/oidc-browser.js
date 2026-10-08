export function browserCookie(request, publicUrl) {
  const name = new URL(publicUrl).protocol === 'https:' ? '__Host-aether-login' : 'aether-login-dev';
  const values = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

// Called only by the trusted backend's PublicApi constructor, never by Gadget code.
export async function bindOidcBrowser(env, request) {
  const browser = browserCookie(request, env.OIDC_PUBLIC_URL);
  if (!browser) throw new Error('Open the sign-in page before using the API');
  return {...env, GATEKEEPER_OIDC:await env.GATEKEEPER_OIDC.forBrowser(browser)};
}

export function randomNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function oidcSessionExpired(session, env) {
  const ttl = Number(env.AETHER_OIDC_SESSION_TTL);
  return !session || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400
    || !(session.created instanceof Date) || !Number.isFinite(session.created.getTime())
    || Date.now() - session.created.getTime() >= ttl * 1000;
}

const sessionGuards = new WeakMap();
export function attachOidcSessionGuard(api, env, ctx, abortSession) {
  sessionGuards.set(api,{env,ctx,abortSession,sessions:new Map(),closed:false});
  return api;
}
export async function authenticateOidcSession(api,token) {
  const guard=sessionGuards.get(api);
  if(!guard || guard.closed)throw new Error('Invalid session');
  const id=await guard.env.OIDC_SESSIONS.authenticate(token);
  if(!guard.sessions.has(id)) {
    const watcher=randomNonce();guard.sessions.set(id,watcher);
    // Losing the registry call on eviction/restart also closes the connection, failing closed.
    guard.ctx.waitUntil((async()=>{
      try {
        while(!guard.closed) {
          const reason=await guard.env.OIDC_SESSIONS.watch(id,watcher);
          if(reason==='renew')continue;
          if(!guard.closed)guard.abortSession(new Error('OIDC session revoked or expired'));
          return;
        }
      } catch {if(!guard.closed)guard.abortSession(new Error('OIDC session registry unavailable'));}
    })());
  }
}
export function guardOidcWebSocket(socket, api) {
  const guard=sessionGuards.get(api);
  if(!guard)throw new Error('Missing OIDC session guard');
  socket.addEventListener('close',()=>{
    guard.closed=true;
    for(const [id,watcher] of guard.sessions)guard.ctx.waitUntil(guard.env.OIDC_SESSIONS.unwatch(id,watcher).catch(()=>{}));
    guard.sessions.clear();
  });
  let queue=Promise.resolve(), queued=0;
  return {
    get readyState(){return socket.readyState;},
    send:message=>socket.send(message),close:(...args)=>socket.close(...args),
    addEventListener(type,listener) {
      if(type!=='message')return socket.addEventListener(type,listener);
      socket.addEventListener(type,event=>{
        if(++queued>256){guard.abortSession(new Error('RPC message capacity exhausted'));return;}
        queue=queue.then(async()=>{
          if(guard.closed)return;
          // Covers all derived capabilities (Gadget/admin/subscription), not only the user API.
          await Promise.all([...guard.sessions.keys()].map(id=>guard.env.OIDC_SESSIONS.check(id)));
          listener.call(socket,event);
        }).catch(()=>guard.abortSession(new Error('OIDC session revoked or expired'))).finally(()=>queued--);
      });
    },
  };
}
