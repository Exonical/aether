import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readJson} from './runner.mjs';

/** A namespace-scoped controller. Kubernetes credentials never enter execution pods. */
export function kubernetesClient({baseUrl, credentials}) {
  return async (method, path, body) => {
    const [token, ca] = await Promise.all([readFile(`${credentials}/token`, 'utf8'), readFile(`${credentials}/ca.crt`)]);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(new URL(path, baseUrl), {method, ca,
        headers: {authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json'}}, response => {
        let size = 0; const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 8388608) return response.destroy(new Error('Response too large'));
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {resolve({status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')});}
          catch {reject(new Error('Invalid Kubernetes response'));}
        });
      });
      request.setTimeout(75000, () => request.destroy(new Error('Kubernetes timeout')));
      request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
}

export function createManager({api, tenant, namespace, image, storageClass, runtimeClass = 'kata', imagePullPolicy = 'IfNotPresent', maxWorkspaces = 32}) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace) || !image || !['Always', 'IfNotPresent', 'Never'].includes(imagePullPolicy)) throw new Error('Invalid execution configuration');
  const base = `/api/v1/namespaces/${namespace}`;
  const locks = new Set();
  let provisioning = false;
  const replyError = () => {throw new Error('Execution service operation failed');};
  const call = async (...args) => {
    const result = await api(...args);
    if (result.status >= 300) replyError();
    return result.body;
  };
  const identity = id => {
    const hash = createHash('sha256').update(`${tenant}:${id}`).digest('hex');
    const name = `aether-ws-${hash.slice(0, 32)}`;
    return {name, metadata: {name, labels: {'aether.dev/execution': tenant}, annotations: {'aether.dev/workspace': id}}};
  };
  const owned = (object, id) => {
    if (object.metadata?.labels?.['aether.dev/execution'] !== tenant || object.metadata?.annotations?.['aether.dev/workspace'] !== id) replyError();
    return object;
  };
  const getPod = async (name, id) => {
    const result = await api('GET', `${base}/pods/${name}`);
    if (result.status === 404) return null;
    if (result.status !== 200) replyError();
    return owned(result.body, id);
  };
  const status = pod => ({state: !pod ? 'suspended' : pod.metadata.deletionTimestamp ? 'stopping'
    : pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True') ? 'ready'
    : pod.status?.phase === 'Failed' ? 'failed' : 'starting'});
  const operation = async (id, body) => {
    const {name, metadata} = identity(id);
    let pod = await getPod(name, id);
    if (body.action === 'status') return status(pod);
    if (body.action === 'start') {
      // PVCs are retained across suspension; count them to prevent unbounded storage allocation.
      let pvc = await api('GET', `${base}/persistentvolumeclaims/${name}`);
      if (pvc.status === 404) {
        const existing = await call('GET', `${base}/persistentvolumeclaims?labelSelector=${encodeURIComponent(`aether.dev/execution=${tenant}`)}&limit=${maxWorkspaces + 1}`);
        if (existing.metadata?.continue || existing.items.length >= maxWorkspaces) throw new Error('Workspace capacity exhausted');
        pvc = await api('POST', `${base}/persistentvolumeclaims`, {apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata,
          spec: {accessModes: ['ReadWriteOnce'], resources: {requests: {storage: '10Gi'}}, ...(storageClass ? {storageClassName: storageClass} : {})}});
      }
      if (![200, 201].includes(pvc.status)) replyError();
      owned(pvc.body, id);
      if (!pod) {
        pod = await call('POST', `${base}/pods`, {apiVersion: 'v1', kind: 'Pod', metadata,
          spec: {automountServiceAccountToken: false, ...(runtimeClass ? {runtimeClassName: runtimeClass} : {}),
            restartPolicy: 'Always', terminationGracePeriodSeconds: 5,
            securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: {type: 'RuntimeDefault'}},
            containers: [{name: 'runner', image, imagePullPolicy,
              securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ['ALL']}},
              resources: {requests: {cpu: '250m', memory: '256Mi'}, limits: {cpu: '2', memory: '2Gi'}},
              readinessProbe: {exec: {command: ['node', '-e', "fetch('http://127.0.0.1:9006/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]}, periodSeconds: 5},
              volumeMounts: [{name: 'workspace', mountPath: '/workspace'}, {name: 'tmp', mountPath: '/tmp'}]}],
            volumes: [{name: 'workspace', persistentVolumeClaim: {claimName: name}}, {name: 'tmp', emptyDir: {sizeLimit: '1Gi'}}]}});
      }
      return status(pod);
    }
    if (body.action === 'suspend') {
      if (pod) await call('DELETE', `${base}/pods/${name}`, {apiVersion: 'v1', kind: 'DeleteOptions', preconditions: {uid: pod.metadata.uid}});
      return {state: pod ? 'stopping' : 'suspended'};
    }
    if (!['exec', 'read', 'write', 'list'].includes(body.action)) throw new Error('Unknown operation');
    if (status(pod).state !== 'ready') throw new Error('Workspace not ready');
    return call('POST', `${base}/pods/${name}:9006/proxy/operation`, body);
  };
  return createServer(async (request, response) => {
    const reply = (statusCode, body) => {response.writeHead(statusCode, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(body));};
    if (request.url === '/healthz' && request.method === 'GET') return reply(200, {ready: true});
    const match = /^\/v1\/workspaces\/([a-f0-9]{64})$/.exec(request.url);
    if (!match || request.method !== 'POST' || request.headers['x-aether-tenant'] !== tenant) return reply(403, {error: 'Execution access denied'});
    let body;
    try {body = await readJson(request);} catch {return reply(400, {error: 'Invalid request'});}
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') return reply(400, {error: 'Invalid request'});
    // Serialize each workspace and all provisioning, without blocking unrelated commands.
    if (locks.size >= 8 || locks.has(match[1]) || (body.action === 'start' && provisioning)) return reply(429, {error: 'Execution service busy'});
    locks.add(match[1]);
    if (body.action === 'start') provisioning = true;
    try {reply(200, await operation(match[1], body));}
    catch {reply(409, {error: 'Execution service operation failed'});}
    finally {locks.delete(match[1]); if (body.action === 'start') provisioning = false;}
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const api = kubernetesClient({baseUrl: 'https://kubernetes.default.svc', credentials: '/var/run/aether-kubernetes'});
  createManager({api, tenant: process.env.AETHER_TENANT_ID, namespace: process.env.AETHER_EXECUTION_NAMESPACE,
    image: process.env.AETHER_EXECUTION_IMAGE, storageClass: process.env.AETHER_EXECUTION_STORAGE_CLASS,
    imagePullPolicy: process.env.AETHER_EXECUTION_PULL_POLICY || 'IfNotPresent',
    runtimeClass: process.env.AETHER_EXECUTION_RUNTIME_CLASS || 'kata'}).listen(9005, '127.0.0.1');
}
