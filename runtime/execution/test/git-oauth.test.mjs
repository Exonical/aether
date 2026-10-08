import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
import {createGitOAuth} from '../git-oauth.mjs';
import {createGitBroker} from '../git-broker.mjs';

const providers = [
  {id: 'gitlab', label: 'GitLab Enterprise', kind: 'gitlab', url: 'https://gitlab.internal'},
  {id: 'github', label: 'GitHub Enterprise Server', kind: 'github', url: 'https://github.internal'},
];
const clients = {gitlab: {clientId: 'gl-app', clientSecret: 'private-gl-secret'}, github: {clientId: 'gh-app', clientSecret: 'private-gh-secret'}};
const close = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();});

test('self-hosted OAuth endpoints, GitLab PKCE/rotation, GHES confidential flow and provider revocation', async () => {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString(), form = new URLSearchParams(text);
    seen.push({path: req.url, method: req.method, headers: req.headers, form, text});
    res.setHeader('content-type', 'application/json');
    if (req.url === '/oauth/token') {
      assert.equal(form.get('client_id'), 'gl-app'); assert.equal(form.get('client_secret'), 'private-gl-secret');
      assert.equal(form.get('redirect_uri'), 'https://aether.internal/git/callback');
      assert.ok(form.get('grant_type') === 'refresh_token' ? form.get('refresh_token') : form.get('code_verifier'));
      res.end(JSON.stringify({access_token: form.has('refresh_token') ? 'rotated-access' : 'gl-access', refresh_token: 'rotated-refresh', expires_in: 7200, scope: 'read_user read_repository', token_type: 'Bearer'}));
    } else if (req.url === '/login/oauth/access_token') {
      assert.equal(form.get('client_secret'), 'private-gh-secret'); assert.equal(form.get('code_verifier'), null);
      res.end(JSON.stringify({access_token: 'gh-access', scope: 'repo,read:user', token_type: 'bearer'}));
    } else if (req.url === '/api/v4/user') {
      assert.equal(req.headers.authorization, 'Bearer gl-access'); assert.equal(req.headers['private-token'], undefined);
      res.end(JSON.stringify({username: 'bryce'}));
    } else if (req.url === '/api/v3/user') {
      assert.equal(req.headers.authorization, 'Bearer gh-access'); res.end(JSON.stringify({login: 'bryce'}));
    } else if (req.url === '/oauth/revoke') {
      assert.equal(form.get('token'), 'rotated-access'); res.end('{}');
    } else if (req.url === '/api/v3/applications/gh-app/token') {
      assert.equal(req.method, 'DELETE'); assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('gh-app:private-gh-secret').toString('base64'));
      assert.equal(JSON.parse(text).access_token, 'gh-access'); res.writeHead(204); res.end();
    } else {res.writeHead(404); res.end('{}');}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const destinations = [];
  const request = (url, options, callback) => {destinations.push(url.href); return httpRequest(new URL(url.pathname, origin), options, callback);};
  const oauth = createGitOAuth({providers, clients, publicUrl: 'https://aether.internal', request, now: () => 100000});
  const broker = createGitBroker({providers, oauth, request, publicUrl: 'http://broker.internal:9007/'});
  try {
    assert.deepEqual(broker.providers(), providers.map(({id, label, kind}) => ({id, label, kind, oauth: true})));
    const state = 'a'.repeat(64), gl = oauth.begin({providerId: 'gitlab', state}), gh = oauth.begin({providerId: 'github', state});
    const authorization = new URL(gl.url);
    assert.equal(authorization.origin, 'https://gitlab.internal'); assert.equal(authorization.pathname, '/oauth/authorize');
    assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(gl.verifier).digest('base64url'));
    assert.equal(authorization.searchParams.get('state'), state);
    assert.ok(!gl.url.includes('private-gl-secret')); assert.ok(!gl.url.includes(gl.verifier));
    assert.equal(new URL(gh.url).pathname, '/login/oauth/authorize'); assert.equal(new URL(gh.url).searchParams.has('code_challenge'), false);
    const glGrant = await oauth.exchange({providerId: 'gitlab', code: 'approved-code', verifier: gl.verifier});
    assert.equal(glGrant.expiresAt, 7300000); assert.equal(glGrant.authentication, 'oauth');
    assert.deepEqual(await broker.verify({providerId: 'gitlab', ...glGrant}), {login: 'bryce'});
    const ghGrant = await oauth.exchange({providerId: 'github', code: 'approved-code', verifier: ''});
    assert.equal(ghGrant.refreshToken, undefined);
    assert.deepEqual(await broker.verify({providerId: 'github', ...ghGrant}), {login: 'bryce'});
    const rotated = await oauth.refresh({providerId: 'gitlab', refreshToken: glGrant.refreshToken});
    assert.equal(rotated.token, 'rotated-access');
    const lease = broker.lease('workspace', {providerId: 'gitlab', token: glGrant.token, connectionId: 'account', repository: 'team/project'});
    assert.equal(lease.includes(glGrant.token), false);
    broker.rotate('account');
    assert.doesNotThrow(() => broker.lease('workspace', {providerId: 'gitlab', token: rotated.token, connectionId: 'account', repository: 'team/project'}));
    await oauth.revoke({providerId: 'gitlab', token: rotated.token}); await oauth.revoke({providerId: 'github', token: ghGrant.token});
    assert.ok(destinations.every(url => /^https:\/\/(gitlab|github)\.internal\//.test(url)));
    assert.equal(seen.filter(item => item.path === '/oauth/token').length, 2);
    assert.throws(() => oauth.refresh({providerId: 'github', refreshToken: 'not-supported'}), /Invalid/);
  } finally {await close(server); await close(broker.server);}
});

test('reject public services, credential-forwarding origins, unknown clients and invalid OAuth input', () => {
  for (const url of ['https://github.com', 'https://gitlab.com', 'http://git.internal', 'https://user:pass@git.internal', 'https://git.internal/subpath']) {
    assert.throws(() => createGitOAuth({providers: [{...providers[0], url}]}), /Invalid/);
  }
  assert.throws(() => createGitOAuth({providers: [{...providers[0], apiUrl: 'https://attacker.internal/api/'}]}), /Invalid/);
  assert.throws(() => createGitOAuth({providers, clients, publicUrl: 'http://aether.internal'}), /HTTPS/);
  assert.throws(() => createGitOAuth({providers, clients: {unknown: clients.gitlab}, publicUrl: 'https://aether.internal'}), /Invalid/);
  const oauth = createGitOAuth({providers, clients, publicUrl: 'https://aether.internal'});
  assert.throws(() => oauth.begin({providerId: 'gitlab', state: 'forged'}), /state/);
  assert.throws(() => oauth.begin({providerId: 'other', state: 'a'.repeat(64)}), /configured/);
  assert.throws(() => oauth.exchange({providerId: 'gitlab', code: 'code', verifier: 'invalid'}), /callback/);
});

test('OAuth responses fail closed on redirects, missing scopes and token-bearing provider errors', async () => {
  let mode = 'scopes';
  const server = createServer((req, res) => {
    req.resume();
    if (mode === 'redirect') {res.writeHead(302, {location: 'https://external.invalid/token'}); res.end();}
    else res.end(JSON.stringify({access_token: 'secret-access', token_type: 'bearer', scope: 'read:user', error_description: 'secret-provider-detail'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (url, options, callback) => httpRequest(new URL(url.pathname, `http://127.0.0.1:${server.address().port}`), options, callback);
  const oauth = createGitOAuth({providers, clients, publicUrl: 'https://aether.internal', request});
  try {
    await assert.rejects(() => oauth.exchange({providerId: 'github', code: 'code'}), /Invalid Git OAuth grant/);
    mode = 'redirect';
    await assert.rejects(() => oauth.exchange({providerId: 'github', code: 'code'}), error => !error.message.includes('secret') && /request failed/.test(error.message));
  } finally {await close(server);}
});

test('GitLab write scopes are an explicit operator opt-in', () => {
  const state = 'a'.repeat(64);
  const readOnly = createGitOAuth({providers, clients, publicUrl: 'https://aether.internal'});
  const writable = createGitOAuth({providers, clients, publicUrl: 'https://aether.internal', allowWrites: true});
  assert.equal(new URL(readOnly.begin({providerId: 'gitlab', state}).url).searchParams.get('scope'), 'read_user read_repository');
  assert.equal(new URL(writable.begin({providerId: 'gitlab', state}).url).searchParams.get('scope'), 'read_user read_repository api write_repository');
});
