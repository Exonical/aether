import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGitActions} from '../git-actions.mjs';
import {createGitBroker} from '../git-broker.mjs';
import {gitProviders} from '../git-providers.mjs';

const workspace = 'a'.repeat(64);
const branch = `aether/${workspace.slice(0, 32)}/fix/login`;
const git = (args, cwd, input) => execFileSync('git', args, {cwd, input, stdio: 'pipe'});
const close = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();});

for (const kind of ['gitlab', 'github']) test(`${kind}: immutable approved push, retry, concurrency, fixed PR transport and revocation`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aether-actions-test-'));
  await mkdir(join(root, 'team')); await mkdir(join(root, 'source'));
  const source = join(root, 'source');
  git(['init', '-q', '-b', 'main'], source);
  const commit = async text => {
    await writeFile(join(source, 'README.md'), text); git(['add', '.'], source);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', text], source);
    return git(['rev-parse', 'HEAD'], source).toString().trim();
  };
  const anchor = await commit('initial');
  const repository = join(root, 'team/project.git');
  git(['clone', '--bare', source, repository], root);
  git(['config', 'http.receivepack', 'true'], repository);
  const approvedHead = await commit('approved change');
  const pack = git(['pack-objects', '--stdout', '--revs', '--window=0'], source, `${approvedHead}\n^${anchor}\n`).toString('base64');
  const seen = []; let pr = null; let posts = 0;
  const upstream = createServer(async (req, res) => {
    seen.push({url: req.url, authorization: req.headers.authorization});
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET') {res.end(JSON.stringify(pr ? [pr] : [])); return;}
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks)); posts++;
      pr = kind === 'gitlab' ? {...data, source_project_id: 1, target_project_id: 1, web_url: 'https://git.internal/team/project/-/merge_requests/1'}
        : {...data, head: {ref: data.head, repo: {full_name: 'team/project'}}, base: {ref: data.base}, html_url: 'https://git.internal/team/project/pull/1'};
      res.writeHead(201); res.end(JSON.stringify(pr)); return;
    }
    if (req.headers.authorization !== 'Basic ' + Buffer.from(`${kind === 'gitlab' ? 'oauth2' : 'x-access-token'}:private-token`).toString('base64')) {res.writeHead(401); res.end(); return;}
    const child = spawn('git', ['http-backend'], {env: {...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'owner'}});
    let header = Buffer.alloc(0), sent = false;
    child.stdout.on('data', chunk => {
      if (sent) {res.write(chunk); return;}
      header = Buffer.concat([header, chunk]); const boundary = header.indexOf('\r\n\r\n'); if (boundary < 0) return;
      const fields = Object.fromEntries(header.subarray(0, boundary).toString().split('\r\n').map(line => {
        const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const status = Number(fields.status?.slice(0, 3) || 200); delete fields.status;
      res.writeHead(status, fields); res.write(header.subarray(boundary + 4)); sent = true;
    });
    child.stderr.resume(); child.on('close', () => res.end()); req.pipe(child.stdin);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${upstream.address().port}`;
  const provider = gitProviders([{id: kind, kind, label: 'Enterprise', url: 'https://git.internal'}]).get(kind);
  const connection = {providerId: kind, connectionId: 'owner-connection', repository: 'team/project', token: 'private-token', authentication: 'oauth'};
  const actions = createGitActions({remote: () => `${url}/team/project.git`,
    request: (target, options, callback) => request(new URL(target.pathname + target.search, url), options, callback)});
  try {
    const prepared = await actions.prepare(provider, connection, workspace, {action: 'push', branch, base: 'main', head: approvedHead, anchor, pack});
    assert.equal(git(['show-ref', '--heads'], repository).toString().includes(branch), false);
    // Later sandbox changes do not alter the captured approval artifact.
    await commit('later unapproved change');
    await assert.rejects(actions.apply(provider, connection, workspace, {...prepared, sha256: 'b'.repeat(64)}), /refused/);
    await assert.rejects(actions.apply(provider, connection, workspace, prepared, () => {throw new Error('Connection revoked');}), /revoked/);
    assert.equal(seen.filter(item => item.url.endsWith('/git-receive-pack')).length, 0);
    await actions.apply(provider, connection, workspace, prepared);
    assert.equal(git(['rev-parse', `refs/heads/${branch}`], repository).toString().trim(), approvedHead);
    const pushRequests = seen.filter(item => item.url.endsWith('/git-receive-pack')).length;
    await actions.apply(provider, connection, workspace, prepared);
    assert.equal(seen.filter(item => item.url.endsWith('/git-receive-pack')).length, pushRequests);
    await assert.rejects(actions.prepare(provider, connection, workspace, {...prepared, branch: 'main'}), /refused/);
    await assert.rejects(actions.prepare(provider, connection, workspace, {...prepared, branch: 'aether/' + 'b'.repeat(16) + '/task'}), /refused/);
    const newerHead = git(['rev-parse', 'HEAD'], source).toString().trim();
    const next = await actions.prepare(provider, connection, workspace, {...prepared, head: newerHead,
      pack: git(['pack-objects', '--stdout', '--revs'], source, `${newerHead}\n`).toString('base64')});
    git(['update-ref', `refs/heads/${branch}`, git(['rev-parse', 'main'], repository).toString().trim()], repository);
    await assert.rejects(actions.apply(provider, connection, workspace, next), /refused/);
    const prAction = await actions.prepare(provider, connection, workspace, {action: 'pull-request', branch, base: 'main', title: 'Fix login', body: 'Exact approved body'});
    const result = await actions.apply(provider, connection, workspace, prAction);
    assert.match(result.url, /^https:\/\/git\.internal\//);
    await actions.apply(provider, connection, workspace, prAction);
    assert.equal(posts, 1);
    await assert.rejects(actions.apply(provider, connection, workspace, {...prAction, body: 'unapproved retry body'}), /refused/);
    assert.ok(seen.filter(item => item.url.startsWith('/api/')).every(item => item.authorization === 'Bearer private-token'));
    const broker = createGitBroker({providers: [{id: kind, kind, label: 'Enterprise', url: 'https://git.internal'}], actions, allowWrites: true});
    broker.revoke(connection.connectionId);
    await assert.rejects(broker.applyAction({workspace, git: connection, action: prAction}), /revoked/);
    const disabled = createGitBroker({providers: [{id: kind, kind, label: 'Enterprise', url: 'https://git.internal'}], actions});
    await assert.rejects(disabled.prepareAction({workspace, git: connection, action: prAction}), /disabled/);
  } finally {await close(upstream); await rm(root, {recursive: true, force: true});}
});
