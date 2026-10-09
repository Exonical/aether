import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createManager} from '../manager.mjs';

test('controller readiness, private diagnostics, actionable errors and redacted Git events', async () => {
  const events = [], workspace = 'a'.repeat(64);
  let healthy = true, rejectGit = false;
  const api = async (method, path) => {
    if (!healthy) throw new Error('upstream credential=do-not-log');
    if (path.includes('/pods?')) return {status: 200, body: {items: []}};
    if (path.includes('/persistentvolumeclaims?')) return {status: 200, body: {items: [{}]}};
    return {status: 404, body: {}};
  };
  const applyAction = async () => {
    if (rejectGit) throw new Error('token=do-not-log');
    return {head: 'b'.repeat(40)};
  };
  const server = createManager({api, tenant: 'acme', namespace: 'aether', image: 'fixture', idleTimeoutSeconds: 0,
    maxWorkspaces: 1, log: event => events.push(event), gitBroker: {applyAction, revokeWorkspace: () => {}}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, tenant = 'acme') => fetch(origin + path, {headers: {'x-aether-tenant': tenant}});
  const post = (path, body) => fetch(origin + path, {method: 'POST', headers: {'content-type': 'application/json', 'x-aether-tenant': 'acme'}, body: JSON.stringify(body)});
  try {
    assert.equal((await get('/readyz')).status, 200);
    healthy = false;
    assert.equal((await get('/readyz')).status, 503);
    assert.equal((await get('/healthz')).status, 200);
    healthy = true;
    assert.equal((await get('/v1/diagnostics', 'other')).status, 403);
    const response = await post(`/v1/workspaces/${workspace}`, {action: 'start', environment: 'rhel10', identity: {username: 'alice', uid: 12345, gid: 23456}});
    assert.equal(response.status, 409);
    const error = await response.json();
    assert.equal(error.code, 'CAPACITY_EXHAUSTED');
    assert.match(error.error, /execution.maxWorkspaces/);
    const body = {workspace, git: {token: 'do-not-log'}, action: {action: 'push', head: 'b'.repeat(40), pack: 'do-not-log', title: 'do-not-log'}};
    assert.equal((await post('/v1/git/apply-action', body)).status, 200);
    rejectGit = true;
    assert.equal((await post('/v1/git/apply-action', body)).status, 400);
    const diagnostics = await (await get('/v1/diagnostics')).json();
    assert.equal(diagnostics.counters.gitApplied, 1);
    assert.equal(diagnostics.counters.errors, 2);
    assert.equal(diagnostics.inFlight, 0);
    assert.ok(events.some(e => e.event === 'git.apply' && e.workspace === workspace && e.outcome === 'success'));
    assert.ok(events.some(e => e.event === 'git.apply' && e.outcome === 'refused_or_failed'));
    assert.doesNotMatch(JSON.stringify(events), /do-not-log/);
    assert.doesNotMatch(JSON.stringify(diagnostics), /do-not-log/);
  } finally {await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});}
});
