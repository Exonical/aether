import {createManager} from '../manager.mjs';
import {createRunner} from '../runner.mjs';
import {join} from 'node:path';

/** Real runners with a synthetic Kubernetes control plane for native authentication tests. */
export async function createExecutionFixture(root, {gitBroker} = {}) {
  const objects = new Map(), runners = new Map(), calls = [];
  const api = async (method, path, body) => {
    calls.push({method, path, body});
    const proxy = /\/pods\/([^:]+):9006\/proxy\/operation$/.exec(path);
    if (proxy) {
      const runner = runners.get(proxy[1]);
      const response = await fetch(`${runner.url}/operation`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
      return {status: response.status, body: await response.json()};
    }
    if (path.includes('?')) return {status: 200, body: {items: [...objects.values()].filter(x => x.kind === (path.includes('/pods?') ? 'Pod' : 'PersistentVolumeClaim'))}};
    if (method === 'PATCH') {
      const object = objects.get(path);
      if (!object || object.metadata.uid !== body[0].value) return {status: 409, body: {}};
      object.metadata.annotations['aether.dev/last-activity'] = body[1].value;
      return {status: 200, body: object};
    }
    if (method === 'GET') return objects.has(path) ? {status: 200, body: objects.get(path)} : {status: 404, body: {}};
    if (method === 'POST') {
      const object = {...body, metadata: {...body.metadata, uid: 'fixture-uid'}, status: {conditions: [{type: 'Ready', status: 'True'}]}};
      if (body.kind === 'Pod') {
        const server = await createRunner({root: join(root, body.metadata.name)});
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        runners.set(body.metadata.name, {server, url: `http://127.0.0.1:${server.address().port}`});
      }
      objects.set(`${path}/${body.metadata.name}`, object); return {status: 201, body: object};
    }
    if (method === 'DELETE') {
      const name = objects.get(path).metadata.name, runner = runners.get(name);
      await new Promise(resolve => {runner.server.close(resolve); runner.server.closeAllConnections();});
      runners.delete(name); objects.delete(path); return {status: 200, body: {}};
    }
    throw new Error('Unexpected fixture request');
  };
  const server = createManager({gitBroker, api, tenant: 'acme', namespace: 'aether', image: 'fixture'});
  await new Promise(resolve => server.listen(9005, '127.0.0.1', resolve));
  return {calls, async close() {
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    for (const {server} of runners.values()) await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
  }};
}
