import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGitBroker} from '../git-broker.mjs';

const listen = async server => {await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`;};
const close = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
const git = (args, cwd) => execFileSync('git', args, {cwd, stdio: 'pipe'});

test('real Git clone uses an expiring read-only repository lease and never records the personal token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aether-git-'));
  await mkdir(join(root, 'team')); await mkdir(join(root, 'source'));
  git(['init', '-q'], join(root, 'source')); await writeFile(join(root, 'source/README.md'), 'private repository\n');
  git(['add', '.'], join(root, 'source')); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'initial'], join(root, 'source'));
  git(['clone', '--bare', join(root, 'source'), join(root, 'team/project.git')], root);
  const personalToken = 'never-put-this-token-in-the-runner';
  const seen = [];
  const upstream = createServer((req, res) => {
    seen.push({url: req.url, headers: req.headers});
    if (req.url === '/api/v4/user') {
      res.writeHead(req.headers['private-token'] === personalToken ? 200 : 401, {'content-type': 'application/json'});
      res.end(JSON.stringify({username: 'bryce'})); return;
    }
    if (req.headers.authorization !== 'Basic ' + Buffer.from('oauth2:' + personalToken).toString('base64')) {res.writeHead(401); res.end(); return;}
    const url = new URL(req.url, 'http://fixture');
    const child = spawn('git', ['http-backend'], {env: {...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'bryce'}});
    let header = Buffer.alloc(0), sent = false;
    child.stdout.on('data', chunk => {
      if (sent) {res.write(chunk); return;}
      header = Buffer.concat([header, chunk]); const boundary = header.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const fields = Object.fromEntries(header.subarray(0, boundary).toString().split('\r\n').map(line => {
        const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
      }));
      const status = Number(fields.status?.slice(0, 3) || 200); delete fields.status;
      res.writeHead(status, fields); res.write(header.subarray(boundary + 4)); sent = true;
    });
    child.on('close', () => res.end()); req.pipe(child.stdin);
  });
  const upstreamUrl = await listen(upstream);
  let clock = Date.now();
  const broker = createGitBroker({providers: [{id: 'gitlab', label: 'Internal GitLab', kind: 'gitlab', url: 'https://git.internal'}],
    publicUrl: 'http://127.0.0.1/', now: () => clock,
    request: (url, options, callback) => request(new URL(url.pathname + url.search, upstreamUrl), options, callback)});
  const brokerUrl = await listen(broker.server);
  // Fixed publicUrl's port is replaced in this fixture; production uses its private Service URL.
  const leased = () => broker.lease('workspace', {connectionId: 'user-connection', providerId: 'gitlab', token: personalToken, repository: 'team/project'}).replace('http://127.0.0.1', brokerUrl);
  try {
    assert.deepEqual(await broker.verify({providerId: 'gitlab', token: personalToken}), {login: 'bryce'});
    await assert.rejects(broker.verify({providerId: 'gitlab', token: 'invalid'}));
    assert.throws(() => broker.lease('workspace', {connectionId: 'id', providerId: 'gitlab', token: personalToken, repository: '../../another'}));
    const remote = leased();
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['clone', '--', remote, join(root, 'checkout')], {stdio: 'pipe'});
      let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))); child.on('error', reject);
    });
    assert.equal(await readFile(join(root, 'checkout/README.md'), 'utf8'), 'private repository\n');
    assert.ok(!(await readFile(join(root, 'checkout/.git/config'), 'utf8')).includes(personalToken));
    assert.equal((await fetch(remote + '/info/refs?service=git-receive-pack')).status, 403);
    assert.equal((await fetch(remote + '/git-receive-pack', {method: 'POST'})).status, 403);
    assert.equal((await fetch(remote.replace('repository.git', 'another.git') + '/info/refs?service=git-upload-pack')).status, 403);
    const requestCount = seen.length;
    broker.revoke('user-connection');
    assert.equal((await fetch(remote + '/info/refs?service=git-upload-pack')).status, 403);
    assert.equal(seen.length, requestCount);
    assert.throws(leased, /revoked/);
    clock += 600001;
    const expiring = leased(); clock += 600001;
    assert.equal((await fetch(expiring + '/info/refs?service=git-upload-pack')).status, 403);
  } finally {await close(broker.server); await close(upstream); await rm(root, {recursive: true, force: true});}
});
