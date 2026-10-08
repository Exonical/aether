import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Agent, fetch as oidcFetch } from 'undici';
import * as oidc from 'openid-client';
import {createRemoteJWKSet, jwtVerify, customFetch} from 'jose';
import { readConfig } from './config.mjs';

const STATE = /^[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/;
export const LOGIN_TTL = 5 * 60 * 1000;

/** The only outbound capability is this deployment's discovered OIDC endpoints. */
export async function createAdapter(config) {
  const agent = new Agent({connect:{ca:config.ca, rejectUnauthorized:true}});
  const discoveryUrl = new URL(config.issuer.href);
  discoveryUrl.pathname = discoveryUrl.pathname.replace(/\/$/, '') + '/.well-known/openid-configuration';
  const allowed = new Set([discoveryUrl.href]);
  const safeFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (!allowed.has(url.href)) throw new Error('OIDC destination denied');
    return oidcFetch(url, {...init, dispatcher:agent, redirect:'manual', signal:AbortSignal.timeout(10000)});
  };
  let client;
  try {
    client = await oidc.discovery(config.issuer, config.clientId,
      {id_token_signed_response_alg:config.signingAlgorithm},
      config.authMethod === 'client_secret_basic' ? oidc.ClientSecretBasic(config.clientSecret) : oidc.ClientSecretPost(config.clientSecret),
      {[oidc.customFetch]:safeFetch, timeout:10,
        execute:[...(config.allowHttp ? [oidc.allowInsecureRequests] : []), oidc.enableNonRepudiationChecks]});
    const metadata = client.serverMetadata();
    if (metadata.issuer !== config.issuerIdentifier || !metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('Issuer or PKCE mismatch');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      const url = new URL(metadata[key]);
      if (url.origin !== config.issuer.origin || url.username || url.password || url.hash || url.search) throw new Error('OIDC endpoints must use issuer origin');
      if (key !== 'authorization_endpoint') allowed.add(url.href);
    }
  } catch (error) { await agent.close(); throw error; }
  const jwks = createRemoteJWKSet(new URL(client.serverMetadata().jwks_uri), {[customFetch]:safeFetch, timeoutDuration:10000});
  const pending = new Map();
  let active = 0;
  const cleanup = setInterval(() => {
    for (const [state, attempt] of pending) if (attempt.expires <= Date.now()) pending.delete(state);
  }, 30000).unref();
  const server = createServer(async (req, res) => {
    const reply = (status, data) => { req.resume(); res.writeHead(status, {'content-type':'application/json', 'cache-control':'no-store'}); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && ['/healthz', '/readyz'].includes(req.url)) return reply(200, {status:'ready'});
    if (req.method !== 'POST' || !['/begin', '/complete', '/verify-logout'].includes(req.url)) return reply(404, {error:'Not found'});
    if (req.headers['x-aether-oidc-tenant'] !== config.tenantId) return reply(403, {error:'Tenant denied'});
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, {error:'JSON required'});
    if (active >= 8) return reply(429, {error:'Login concurrency limit'});
    active++;
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        size += chunk.length;
        if (size > 16384) return reply(413, {error:'Request too large'});
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/verify-logout') {
        if (typeof body?.logoutToken !== 'string' || body.logoutToken.length > 12000) throw new Error('Invalid logout');
        const {payload, protectedHeader} = await jwtVerify(body.logoutToken, jwks, {
          issuer:config.issuerIdentifier, audience:config.clientId, algorithms:[config.signingAlgorithm],
          requiredClaims:['iss','aud','iat','jti','events'], maxTokenAge:300, clockTolerance:5});
        const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
        const event = payload.events?.['http://schemas.openid.net/event/backchannel-logout'];
        if (!event || typeof event !== 'object' || Array.isArray(event) || Object.hasOwn(payload,'nonce')
            || !validId(payload.jti) || !(validId(payload.sub) || validId(payload.sid))
            || (Object.hasOwn(payload,'sub') && !validId(payload.sub)) || (Object.hasOwn(payload,'sid') && !validId(payload.sid))
            || (protectedHeader.typ && !['JWT','logout+jwt'].includes(protectedHeader.typ))) throw new Error('Invalid logout claims');
        return reply(200, {issuer:payload.iss, subject:payload.sub ?? null, sid:payload.sid ?? null,
          issuedAt:payload.iat, jti:payload.jti});
      }
      if (!STATE.test(body?.state || '')) return reply(400, {error:'Invalid login'});
      if (req.url === '/begin') {
        for (const [state, attempt] of pending) if (attempt.expires <= Date.now()) pending.delete(state);
        if (pending.has(body.state)) return reply(409, {error:'Login already started'});
        if (pending.size >= 128) return reply(429, {error:'Pending login limit'});
        const verifier = oidc.randomPKCECodeVerifier();
        const nonce = oidc.randomNonce();
        const url = oidc.buildAuthorizationUrl(client, {redirect_uri:config.redirectUri, scope:'openid email profile',
          response_type:'code', response_mode:'query', state:body.state, nonce,
          code_challenge:await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method:'S256'});
        pending.set(body.state, {verifier, nonce, expires:Date.now() + LOGIN_TTL});
        return reply(200, {url:url.href});
      }
      const attempt = pending.get(body.state);
      // Consume before awaiting the provider: concurrent/replayed codes never authenticate twice.
      pending.delete(body.state);
      if (!attempt || attempt.expires <= Date.now()) return reply(400, {error:'Expired or consumed login'});
      const callback = new URL(body.callback);
      if (callback.origin !== config.publicUrl.origin || callback.pathname !== '/gatekeeper/oidc/oauth'
          || callback.username || callback.password || callback.hash || callback.searchParams.getAll('state').length !== 1
          || callback.searchParams.get('state') !== body.state) return reply(400, {error:'Invalid callback'});
      const tokens = await oidc.authorizationCodeGrant(client, callback, {
        expectedState:body.state, expectedNonce:attempt.nonce, pkceCodeVerifier:attempt.verifier, idTokenExpected:true});
      const claims = tokens.claims();
      if (!claims || claims.email_verified !== true || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 || /[\x00-\x1f\x7f]/.test(claims.sub)
          || typeof claims.email !== 'string' || claims.email.length > 254 || /[\x00-\x1f\x7f]/.test(claims.email) || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(claims.email)) throw new Error('Verified email required');
      if (config.requiredClaim) {
        const value = claims[config.requiredClaim];
        if (value !== config.requiredValue && !(Array.isArray(value) && value.includes(config.requiredValue))) throw new Error('Membership denied');
      }
      if (claims.sid !== undefined && (typeof claims.sid !== 'string' || !claims.sid || claims.sid.length > 1024 || /[\x00-\x1f\x7f]/.test(claims.sid))) throw new Error('Invalid session ID');
      // Provider credentials never enter a Gadget, session token, durable storage, or response.
      return reply(200, {email:claims.email, subject:claims.sub, issuer:claims.iss, sid:claims.sid ?? null, issuedAt:claims.iat});
    } catch (error) {
      const unavailable=req.url==='/verify-logout' && (['ERR_JWKS_TIMEOUT','ERR_JWKS_NO_MATCHING_KEY','ERR_JWKS_INVALID'].includes(error.code)
        || ['TypeError','TimeoutError','AbortError'].includes(error.name));
      reply(unavailable ? 503:400, {error:'OIDC request failed'});
    }
    finally { active--; }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  return {server, listen:async (port = config.port) => {
    await new Promise((accept, reject) => {server.once('error',reject); server.listen(port,'127.0.0.1',()=>{server.off('error',reject);accept()})});
    return server.address().port;
  }, close:async () => {
    clearInterval(cleanup); pending.clear(); server.closeAllConnections();
    await new Promise(accept => server.close(accept)); await agent.close();
  }};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const adapter = await createAdapter(await readConfig()); await adapter.listen();
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>adapter.close().then(()=>process.exit(0)));
  } catch { console.error('OIDC startup failed: check issuer, client and deployment configuration'); process.exitCode = 1; }
}
