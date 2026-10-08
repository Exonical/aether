import {randomBytes, createHash} from 'node:crypto';
import {request as httpsRequest} from 'node:https';
import {gitProviders} from './git-providers.mjs';

const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
  && [...value].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127);

/** Private OAuth client: credentials, PKCE verifiers and provider responses never reach runners. */
export function createGitOAuth({providers = [], clients = {}, publicUrl, request = httpsRequest, now = Date.now}) {
  const approved = gitProviders(providers);
  const callback = publicUrl ? new URL('/git/callback', publicUrl) : null;
  if (Object.keys(clients).length && (!callback || callback.protocol !== 'https:' || callback.username || callback.password)) throw new Error('Git OAuth requires a public HTTPS application URL');
  for (const [id, client] of Object.entries(clients)) {
    if (!approved.has(id) || !secret(client.clientId) || !secret(client.clientSecret)) throw new Error('Invalid Git OAuth client');
  }
  const configuration = id => {
    const provider = approved.get(id), client = Object.hasOwn(clients, id) ? clients[id] : null;
    if (!provider || !client || !callback) throw new Error('Git OAuth is not configured');
    return {provider, client};
  };
  const json = (url, method, body, headers = {}) => new Promise((resolve, reject) => {
    const upstream = request(url, {method, headers: {accept: 'application/json', 'user-agent': 'aether',
      ...(body !== undefined ? {'content-length': Buffer.byteLength(body)} : {}), ...headers}}, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {size += chunk.length; if (size > 65536) response.destroy(new Error('Git OAuth response too large')); else chunks.push(chunk);});
      response.on('error', reject);
      response.on('end', () => {
        // Do not follow redirects or reflect provider errors (which may contain credentials).
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('Git OAuth request failed'));
        try {resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));}
        catch {reject(new Error('Invalid Git OAuth response'));}
      });
    });
    const timer = setTimeout(() => upstream.destroy(new Error('Git OAuth timeout')), 15000);
    upstream.once('close', () => clearTimeout(timer)); upstream.on('error', () => reject(new Error('Git OAuth request failed')));
    upstream.end(body);
  });
  const grant = (provider, data) => {
    const scopes = typeof data.scope === 'string' ? data.scope.split(/[ ,]+/) : [];
    const required = provider.kind === 'gitlab' ? ['read_user', 'read_repository'] : ['repo'];
    if (!secret(data.access_token) || String(data.token_type).toLowerCase() !== 'bearer'
        || !required.every(scope => scopes.includes(scope))
        || (provider.kind === 'github' && !scopes.includes('read:user') && !scopes.includes('user'))
        || (provider.kind === 'gitlab' && (!secret(data.refresh_token) || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 31536000))) throw new Error('Invalid Git OAuth grant');
    return {token: data.access_token, authentication: 'oauth', ...(provider.kind === 'gitlab'
      ? {refreshToken: data.refresh_token, expiresAt: now() + data.expires_in * 1000} : {})};
  };
  const token = async (id, parameters) => {
    const {provider, client} = configuration(id);
    const body = new URLSearchParams({...parameters, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: callback.href}).toString();
    return grant(provider, await json(new URL(provider.kind === 'gitlab' ? '/oauth/token' : '/login/oauth/access_token', provider.url), 'POST', body, {'content-type': 'application/x-www-form-urlencoded'}));
  };
  return {
    enabled: id => Object.hasOwn(clients, id),
    begin: ({providerId, state}) => {
      const {provider, client} = configuration(providerId);
      if (!/^[a-f0-9]{64}$/.test(state)) throw new Error('Invalid Git OAuth state');
      const url = new URL(provider.kind === 'gitlab' ? '/oauth/authorize' : '/login/oauth/authorize', provider.url);
      const verifier = provider.kind === 'gitlab' ? randomBytes(32).toString('base64url') : '';
      url.search = new URLSearchParams({client_id: client.clientId, redirect_uri: callback.href, response_type: 'code', state,
        scope: provider.kind === 'gitlab' ? 'read_user read_repository' : 'repo read:user',
        ...(verifier ? {code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'} : {allow_signup: 'false'})}).toString();
      return {url: url.href, verifier};
    },
    exchange: ({providerId, code, verifier}) => {
      const {provider} = configuration(providerId);
      if (!secret(code) || (provider.kind === 'gitlab' && (typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(verifier)))) throw new Error('Invalid Git OAuth callback');
      return token(providerId, {grant_type: 'authorization_code', code, ...(provider.kind === 'gitlab' ? {code_verifier: verifier} : {})});
    },
    refresh: ({providerId, refreshToken}) => {
      if (configuration(providerId).provider.kind !== 'gitlab' || !secret(refreshToken)) throw new Error('Invalid Git OAuth refresh');
      return token(providerId, {grant_type: 'refresh_token', refresh_token: refreshToken});
    },
    revoke: async ({providerId, token}) => {
      const {provider, client} = configuration(providerId);
      if (!secret(token)) throw new Error('Invalid Git OAuth token');
      if (provider.kind === 'gitlab') {
        await json(new URL('/oauth/revoke', provider.url), 'POST', new URLSearchParams({client_id: client.clientId, client_secret: client.clientSecret, token}).toString(), {'content-type': 'application/x-www-form-urlencoded'});
      } else {
        await json(new URL(`applications/${encodeURIComponent(client.clientId)}/token`, provider.api), 'DELETE', JSON.stringify({access_token: token}),
          {'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64')}`});
      }
      return {};
    },
  };
}
