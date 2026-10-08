import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, symlink, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRunner} from '../runner.mjs';
import {createManager} from '../manager.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, body, headers = {}) => fetch(url, {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
const close = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();});

test('real Linux runner: git worktree, files, restart persistence, confinement, deadlines and output limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aether-execution-'));
  let runner = await createRunner({root, timeoutMs: 150, outputLimit: 4096});
  let url = await listen(runner);
  const operation = async body => {const response = await post(`${url}/operation`, body); assert.equal(response.status, 200); return response.json();};
  try {
    const init = await operation({action: 'exec', command: 'git init -q && git config user.email fixture@example.com && git config user.name Fixture && printf original > README.md && git add . && git commit -qm initial'});
    assert.equal(init.exitCode, 0);
    await operation({action: 'write', path: 'README.md', content: 'edited\n'});
    const diff = await operation({action: 'exec', command: 'git diff -- README.md'});
    assert.match(diff.output, /\+edited/);
    await close(runner); runner = await createRunner({root, timeoutMs: 150, outputLimit: 4096}); url = await listen(runner);
    assert.equal((await operation({action: 'read', path: 'README.md'})).content, 'edited\n');
    await symlink('/etc/passwd', join(root, 'escape'));
    for (const path of ['../escape', '/etc/passwd', 'escape']) {
      assert.equal((await post(`${url}/operation`, {action: 'read', path})).status, 400);
      assert.equal((await post(`${url}/operation`, {action: 'write', path, content: 'denied'})).status, 400);
    }
    await operation({action: 'exec', command: 'mkfifo pipe'});
    for (const action of ['read', 'write']) assert.equal((await post(`${url}/operation`, {action, path: 'pipe', content: 'denied'})).status, 400);
    assert.equal((await operation({action: 'exec', command: 'sleep 5'})).timedOut, true);
    const flood = await operation({action: 'exec', command: 'yes x'});
    assert.equal(flood.truncated, true); assert.ok(Buffer.byteLength(flood.output) <= 4096);
    const blocked = post(`${url}/operation`, {action: 'exec', command: 'sleep 5'});
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await post(`${url}/operation`, {action: 'list', path: '.'})).status, 429);
    await blocked;
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'edited\n');
  } finally {await close(runner); await rm(root, {recursive: true, force: true});}
});

test('controller scopes pods, retains PVCs, denies identity forgery and refuses resource adoption', async () => {
  const resources = new Map(), calls = [];
  const api = async (method, path, body) => {
    calls.push({method, path, body});
    if (path.includes('/proxy/')) return {status: 200, body: {output: 'fixture', exitCode: 0}};
    if (path.includes('?')) return {status: 200, body: {items: [...resources.values()].filter(x => x.kind === 'PersistentVolumeClaim')}};
    if (method === 'GET') return resources.has(path) ? {status: 200, body: resources.get(path)} : {status: 404, body: {}};
    if (method === 'POST') {
      const object = {...body, metadata: {...body.metadata, uid: 'fixture-uid'}, status: {conditions: [{type: 'Ready', status: 'True'}]}};
      resources.set(`${path}/${body.metadata.name}`, object); return {status: 201, body: object};
    }
    if (method === 'DELETE') {resources.delete(path); return {status: 200, body: {}};}
    throw new Error('Unexpected API request');
  };
  const manager = createManager({api, tenant: 'acme', namespace: 'aether', image: 'registry.invalid/runner:fixture', maxWorkspaces: 1});
  const url = await listen(manager), id = 'a'.repeat(64), other = 'b'.repeat(64);
  const operation = async (action, workspace = id, tenant = 'acme') => post(`${url}/v1/workspaces/${workspace}`, {action}, {'x-aether-tenant': tenant});
  try {
    for (const body of [null, [], 'invalid', {}]) assert.equal((await post(`${url}/v1/workspaces/${id}`, body, {'x-aether-tenant': 'acme'})).status, 400);
    assert.equal((await operation('start', id, 'other')).status, 403);
    assert.equal((await operation('start', '../escape')).status, 403);
    assert.equal((await operation('start')).status, 200);
    const pod = calls.find(x => x.body?.kind === 'Pod').body;
    assert.equal(pod.spec.automountServiceAccountToken, false); assert.equal(pod.spec.runtimeClassName, 'kata');
    assert.equal(pod.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.equal(pod.spec.containers[0].env, undefined);
    assert.equal((await operation('exec')).status, 200);
    assert.equal((await operation('suspend')).status, 200);
    assert.equal([...resources.values()].filter(x => x.kind === 'PersistentVolumeClaim').length, 1);
    assert.equal((await operation('start', other)).status, 409);
    assert.equal((await operation('start')).status, 200);
    const storedPod = [...resources.values()].find(x => x.kind === 'Pod');
    storedPod.metadata.annotations['aether.dev/workspace'] = other;
    assert.equal((await operation('exec')).status, 409);
    assert.equal((await operation('suspend')).status, 409);
    assert.equal(calls.filter(x => x.method === 'DELETE').length, 1);
  } finally {await close(manager);}
});
