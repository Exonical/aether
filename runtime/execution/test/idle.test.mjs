import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createManager} from '../manager.mjs';

const id = 'a'.repeat(64), other = 'b'.repeat(64);
const close = server => new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
const successfulProxy = async () => ({status: 200, body: {exitCode: 0}});
const noop = () => {};

function fixture({idleTimeoutSeconds = 30, retentionSeconds = 0} = {}) {
  let clock = Date.parse('2026-10-08T00:00:00Z'), revision = 0, proxy = successfulProxy;
  const resources = new Map(), calls = [], revoked = [];
  let pageSnapshot = [], failDelete = false, deleted = noop, finishDeletion = false;
  const api = async (method, path, body, options) => {
    calls.push({method, path, body, options});
    if (path.includes('/proxy/')) return proxy();
    if (path.includes('?')) {
      const kind = path.includes('/pods?') ? 'Pod' : 'PersistentVolumeClaim';
      // Two pages ensure reconciliation follows Kubernetes continuation tokens.
      if (!path.includes('&continue=')) pageSnapshot = [...resources.values()].filter(x => x.kind === kind).map(x => structuredClone(x));
      const items = pageSnapshot;
      return {status: 200, body: {items: path.includes('&continue=') ? items.slice(1) : items.slice(0, 1),
        metadata: !path.includes('&continue=') && items.length > 1 ? {continue: 'next/page'} : {}}};
    }
    if (method === 'GET') {
      const object = resources.get(path);
      if (finishDeletion && object?.metadata.deletionTimestamp) {
        finishDeletion = false;
        const result = structuredClone(object);
        resources.delete(path);
        return {status: 200, body: result};
      }
      return object ? {status: 200, body: structuredClone(object)} : {status: 404, body: {}};
    }
    if (method === 'POST') {
      const object = structuredClone(body);
      object.metadata = {...object.metadata, uid: `uid-${++revision}`, resourceVersion: String(revision), creationTimestamp: new Date(clock).toISOString()};
      object.status = {conditions: [{type: 'Ready', status: 'True'}]};
      resources.set(`${path}/${body.metadata.name}`, object);
      return {status: 201, body: structuredClone(object)};
    }
    const object = resources.get(path);
    if (method === 'PATCH') {
      assert.equal(options.contentType, 'application/json-patch+json');
      assert.equal(body[0].value, object.metadata.uid);
      object.metadata.annotations[body[1].path.split('/').at(-1).replaceAll('~1', '/')] = body[1].value;
      object.metadata.resourceVersion = String(++revision);
      return {status: 200, body: structuredClone(object)};
    }
    if (method === 'DELETE') {
      if (failDelete) {
        failDelete = false;
        object.metadata.resourceVersion = String(++revision);
        return {status: 409, body: {}};
      }
      assert.equal(body.preconditions.uid, object.metadata.uid);
      if (body.preconditions.resourceVersion !== undefined) assert.equal(body.preconditions.resourceVersion, object.metadata.resourceVersion);
      resources.delete(path); deleted(); return {status: 200, body: {}};
    }
    throw new Error('Unexpected API request');
  };
  const create = ({idleCheckIntervalMs, log = noop, gitBroker = {revokeWorkspace: workspace => revoked.push(workspace)}} = {}) => createManager({api, tenant: 'acme', namespace: 'aether', image: 'fixture', idleTimeoutSeconds, retentionSeconds, idleCheckIntervalMs,
    now: () => clock, gitBroker, log});
  return {resources, calls, revoked, create, advance: ms => {clock += ms;}, setProxy: handler => {proxy = handler;},
    failNextDelete: () => {failDelete = true;}, onDelete: handler => {deleted = handler;},
    finishDeletingPod: () => {finishDeletion = true;}};
}

async function client(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return async (action, workspace = id, git) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/workspaces/${workspace}`, {method: 'POST',
      headers: {'content-type': 'application/json', 'x-aether-tenant': 'acme'},
      body: JSON.stringify({action, ...(action === 'start' ? {environment: 'rhel10', identity: {username: 'bryce', uid: 12345, gid: 23456}, ...(git ? {git} : {})} : {})})});
    assert.equal(response.status, 200);
    return response.json();
  };
}

test('idle suspension survives controller restart, ignores status polling and retains resumable PVCs', async () => {
  const f = fixture(), server = f.create(), operation = await client(server);
  try {
    await operation('start');
    f.advance(20000); await operation('status');
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 0, failed: 0});
    f.advance(10000);
    // A new controller sees the persisted activity rather than a fresh in-memory deadline.
    const restarted = f.create();
    assert.deepEqual(await restarted.suspendIdleWorkspaces(), {suspended: 1, failed: 0});
    assert.equal((await operation('status')).state, 'suspended');
    assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
    assert.ok(f.calls.find(c => c.method === 'DELETE').body.preconditions.resourceVersion);
    assert.equal(f.revoked.at(-1), id);
    const pvc = [...f.resources.values()].find(x => x.kind === 'PersistentVolumeClaim');
    assert.ok(pvc);
    await operation('start');
    assert.equal([...f.resources.values()].find(x => x.kind === 'PersistentVolumeClaim').metadata.uid, pvc.metadata.uid);
    assert.equal((await operation('status')).state, 'ready');
  } finally {await close(server);}
});

test('workspace operations extend the deadline and an in-flight command cannot be suspended', async () => {
  const f = fixture(), server = f.create(), operation = await client(server);
  try {
    await operation('start');
    for (const action of ['exec', 'read', 'write', 'list', 'start']) {
      f.advance(29000); await operation(action);
      assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 0, failed: 0});
    }
    let release, entered;
    const started = new Promise(resolve => {entered = resolve;});
    f.setProxy(() => new Promise(resolve => {release = () => resolve({status: 200, body: {exitCode: 0}}); entered();}));
    const active = operation('exec'); await started;
    f.advance(31000);
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 0, failed: 0});
    release(); await active;
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 0, failed: 0});
    f.advance(30000);
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 1, failed: 0});
  } finally {await close(server);}
});

test('paged cleanup handles legacy pods and skips foreign or unowned resources', async () => {
  const f = fixture(), server = f.create(), operation = await client(server);
  try {
    await operation('start'); await operation('start', other);
    const pods = [...f.resources.values()].filter(x => x.kind === 'Pod');
    delete pods[0].metadata.annotations['aether.dev/last-activity'];
    const foreign = structuredClone(pods[1]);
    foreign.metadata.labels['aether.dev/execution'] = 'other';
    f.resources.set('/api/v1/namespaces/aether/pods/foreign', foreign);
    const unowned = structuredClone(pods[1]); unowned.metadata.name = 'aether-ws-unowned';
    f.resources.set('/api/v1/namespaces/aether/pods/aether-ws-unowned', unowned);
    f.advance(30000);
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 2, failed: 0});
    assert.equal([...f.resources.values()].filter(x => x.kind === 'Pod').length, 2);
    assert.equal([...f.resources.values()].filter(x => x.kind === 'PersistentVolumeClaim').length, 2);
    assert.ok(f.calls.some(c => c.path.includes('&continue=next%2Fpage')));
  } finally {await close(server);}
});

test('zero timeout disables scans and activity patches', async () => {
  const f = fixture({idleTimeoutSeconds: 0}), server = f.create(), operation = await client(server);
  try {
    await operation('start'); f.advance(604800000); await operation('exec');
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 0, failed: 0});
    assert.equal(f.calls.filter(c => c.method === 'PATCH' || c.path.includes('/pods?') || c.method === 'DELETE').length, 0);
  } finally {await close(server);}
  for (const idleTimeoutSeconds of [-1, 604801, 1.5, '1800', NaN]) assert.throws(() => fixture({idleTimeoutSeconds}).create(), /Invalid idle/);
});

test('a Kubernetes deletion conflict leaves the pod and Git lease intact and is retried', async () => {
  const f = fixture(), server = f.create(), operation = await client(server);
  try {
    await operation('start'); f.advance(30000);
    const revocations = f.revoked.length;
    f.failNextDelete();
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 0, failed: 1});
    assert.equal((await operation('status')).state, 'ready');
    assert.equal(f.revoked.length, revocations);
    assert.deepEqual(await server.suspendIdleWorkspaces(), {suspended: 1, failed: 0});
    assert.equal(f.revoked.length, revocations + 1);
  } finally {await close(server);}
});

test('listening triggers startup and periodic reconciliation, and closing stops the timer', async () => {
  const f = fixture(), original = f.create(), operation = await client(original);
  await operation('start'); await close(original); f.advance(30000);
  const server = f.create({idleCheckIntervalMs: 10});
  let waitForDelete = new Promise(resolve => f.onDelete(resolve));
  const resumed = await client(server);
  try {
    await waitForDelete; // Startup cleanup handles the pod left by the previous controller.
    await resumed('start');
    waitForDelete = new Promise(resolve => f.onDelete(resolve));
    f.advance(30000);
    await waitForDelete; // The interval handles later inactivity without an HTTP request.
    assert.equal((await resumed('status')).state, 'suspended');
  } finally {await close(server);}
  const scans = f.calls.filter(c => c.path.includes('/pods?')).length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.calls.filter(c => c.path.includes('/pods?')).length, scans);
});

test('a start arriving while Kubernetes is deleting a pod waits and recreates it on the same PVC', async () => {
  const f = fixture(), server = f.create(), operation = await client(server);
  try {
    await operation('start');
    const pod = [...f.resources.values()].find(x => x.kind === 'Pod');
    const pvc = [...f.resources.values()].find(x => x.kind === 'PersistentVolumeClaim');
    pod.metadata.deletionTimestamp = '2026-10-08T00:00:00Z';
    f.finishDeletingPod();
    assert.equal((await operation('start')).state, 'ready');
    assert.notEqual([...f.resources.values()].find(x => x.kind === 'Pod').metadata.uid, pod.metadata.uid);
    assert.equal([...f.resources.values()].find(x => x.kind === 'PersistentVolumeClaim').metadata.uid, pvc.metadata.uid);
  } finally {await close(server);}
});


test('retention is opt-in, durable, skips resumed/legacy PVCs and retries conflicting deletions', async () => {
  const f = fixture({retentionSeconds: 60}), server = f.create(), operation = await client(server);
  try {
    await operation('start'); await operation('suspend');
    f.advance(59000);
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 0, failed: 0});
    await operation('start'); f.advance(1000);
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 0, failed: 0});
    await operation('suspend'); f.advance(60000);
    f.failNextDelete();
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 0, failed: 1});
    assert.deepEqual(await f.create().cleanupRetainedWorkspaces(), {deleted: 1, failed: 0});
    assert.equal(f.resources.size, 0);
    await operation('start'); await operation('suspend');
    delete [...f.resources.values()][0].metadata.annotations['aether.dev/retained-since'];
    f.advance(60000);
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 0, failed: 0});
  } finally {await close(server);}
  const disabled = fixture(), manager = disabled.create(), call = await client(manager);
  try {
    await call('start'); await call('suspend'); disabled.advance(31536000000);
    assert.deepEqual(await manager.cleanupRetainedWorkspaces(), {deleted: 0, failed: 0});
    assert.equal(disabled.resources.size, 1);
  } finally {await close(manager);}
  for (const retentionSeconds of [-1, 31536001, 1.5, NaN]) assert.throws(() => fixture({retentionSeconds}).create(), /Invalid workspace/);
});

test('terminal pod recovery preserves the same PVC', async () => {
  const f = fixture(), server = f.create(), operation = await client(server);
  try {
    await operation('start');
    const pvc = [...f.resources.values()].find(x => x.kind === 'PersistentVolumeClaim');
    for (const phase of ['Failed', 'Succeeded']) {
      const pod = [...f.resources.values()].find(x => x.kind === 'Pod');
      pod.status = {phase};
      assert.equal((await operation('start')).state, 'ready');
      assert.notEqual([...f.resources.values()].find(x => x.kind === 'Pod').metadata.uid, pod.metadata.uid);
      assert.equal([...f.resources.values()].find(x => x.kind === 'PersistentVolumeClaim').metadata.uid, pvc.metadata.uid);
    }
  } finally {await close(server);}
});


test('retention skips terminating pods, foreign PVCs and an active command', async () => {
  const f = fixture({retentionSeconds: 60}), server = f.create(), operation = await client(server);
  try {
    await operation('start'); await operation('suspend'); f.advance(60000);
    const pvc = [...f.resources.values()][0];
    const podCall = f.calls.find(c => c.body?.kind === 'Pod');
    const path = `/api/v1/namespaces/aether/pods/${pvc.metadata.name}`;
    const terminating = structuredClone(podCall.body);
    terminating.metadata.deletionTimestamp = '2026-10-08T00:01:00Z';
    f.resources.set(path, terminating);
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 0, failed: 0});
    f.resources.delete(path);
    const foreign = structuredClone(pvc);
    foreign.metadata.name = 'foreign'; foreign.metadata.labels['aether.dev/execution'] = 'other';
    f.resources.set('/api/v1/namespaces/aether/persistentvolumeclaims/foreign', foreign);
    await operation('start');
    let release, entered;
    const started = new Promise(resolve => {entered = resolve;});
    f.setProxy(() => new Promise(resolve => {release = () => resolve({status: 200, body: {exitCode: 0}}); entered();}));
    const active = operation('exec'); await started;
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 0, failed: 0});
    release(); await active; await operation('suspend'); f.advance(60000);
    assert.deepEqual(await server.cleanupRetainedWorkspaces(), {deleted: 1, failed: 0});
    assert.equal(f.resources.size, 1);
  } finally {await close(server);}
});


test('terminal recovery revokes old Git lease before creating the replacement lease', async () => {
  const events = [], f = fixture();
  const gitBroker = {revokeWorkspace: () => events.push('revoke'), lease: () => {events.push('lease'); return 'http://broker.invalid/opaque';}};
  const server = f.create({gitBroker}), operation = await client(server);
  const git = {providerId: 'internal', repository: 'department/project'};
  try {
    await operation('start', id, git); events.length = 0;
    [...f.resources.values()].find(x => x.kind === 'Pod').status = {phase: 'Failed'};
    await operation('start', id, git);
    assert.deepEqual(events, ['revoke', 'lease']);
  } finally {await close(server);}
});


test('lifecycle events and bounded status reasons omit raw Kubernetes messages', async () => {
  const f = fixture({retentionSeconds: 60}), events = [];
  const server = f.create({log: event => events.push(event)}), operation = await client(server);
  try {
    await operation('start');
    const pod = [...f.resources.values()].find(x => x.kind === 'Pod');
    for (const [status, reason] of [
      [{conditions: [{type: 'PodScheduled', status: 'False', message: 'do-not-log'}]}, 'SCHEDULING_BLOCKED'],
      [{containerStatuses: [{state: {waiting: {reason: 'ImagePullBackOff', message: 'do-not-log'}}}]}, 'IMAGE_PULL_FAILED'],
      [{containerStatuses: [{state: {waiting: {reason: 'CrashLoopBackOff', message: 'do-not-log'}}}]}, 'RUNNER_CRASH_LOOP'],
    ]) {
      pod.status = status;
      const response = await operation('status');
      assert.equal(response.reason, reason);
      assert.doesNotMatch(JSON.stringify(response), /do-not-log/);
    }
    await operation('suspend'); f.advance(60000); await server.cleanupRetainedWorkspaces();
    assert.deepEqual(events.map(e => e.event), ['workspace.started', 'workspace.suspended', 'workspace.retired']);
    assert.doesNotMatch(JSON.stringify(events), /do-not-log/);
  } finally {await close(server);}
});
