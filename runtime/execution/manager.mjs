import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readJson} from './runner.mjs';
import {createGitBroker} from './git-broker.mjs';
import {createGitOAuth} from './git-oauth.mjs';

/** A namespace-scoped controller. Kubernetes credentials never enter execution pods. */
export function kubernetesClient({baseUrl, credentials}) {
  return async (method, path, body, {contentType = 'application/json'} = {}) => {
    const [token, ca] = await Promise.all([readFile(`${credentials}/token`, 'utf8'), readFile(`${credentials}/ca.crt`)]);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(new URL(path, baseUrl), {method, ca,
        headers: {authorization: `Bearer ${token.trim()}`, 'content-type': contentType}}, response => {
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

export function createManager({api, tenant, namespace, image, storageClass, runtimeClass = 'kata', imagePullPolicy = 'IfNotPresent', maxWorkspaces = 32, imagePullSecrets = [], gitBroker = createGitBroker({}), idleTimeoutSeconds = 1800, idleCheckIntervalMs = 60000, now = Date.now}) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace) || !image || !runtimeClass || !['Always', 'IfNotPresent', 'Never'].includes(imagePullPolicy)) throw new Error('Invalid execution configuration');
  if (!Number.isInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 0 || idleTimeoutSeconds > 604800
      || !Number.isInteger(idleCheckIntervalMs) || idleCheckIntervalMs < 1) throw new Error('Invalid idle suspension configuration');
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
  const activityAnnotation = 'aether.dev/last-activity';
  const touch = async pod => {
    if (!idleTimeoutSeconds || pod.metadata.deletionTimestamp) return;
    // Persist activity on the pod so a controller restart cannot reset the idle deadline.
    await call('PATCH', `${base}/pods/${pod.metadata.name}`, [
      {op: 'test', path: '/metadata/uid', value: pod.metadata.uid},
      {op: 'add', path: '/metadata/annotations/aether.dev~1last-activity', value: String(now())},
    ], {contentType: 'application/json-patch+json'});
  };
  const suspend = async (id, pod, idle = false) => {
    if (!idle) gitBroker.revokeWorkspace(id);
    if (pod) await call('DELETE', `${base}/pods/${pod.metadata.name}`, {apiVersion: 'v1', kind: 'DeleteOptions',
      preconditions: {uid: pod.metadata.uid, ...(idle ? {resourceVersion: pod.metadata.resourceVersion} : {})}});
    if (idle) gitBroker.revokeWorkspace(id);
  };
  let reconciling = false;
  const suspendIdleWorkspaces = async () => {
    const result = {suspended: 0, failed: 0};
    if (!idleTimeoutSeconds || reconciling) return result;
    reconciling = true;
    try {
      let continuation = '';
      do {
        const page = await call('GET', `${base}/pods?labelSelector=${encodeURIComponent(`aether.dev/execution=${tenant}`)}&limit=100${continuation ? `&continue=${encodeURIComponent(continuation)}` : ''}`);
        for (const candidate of page.items) {
          const id = candidate.metadata?.annotations?.['aether.dev/workspace'];
          if (!/^[a-f0-9]{64}$/.test(id ?? '') || candidate.metadata.name !== identity(id).name
              || candidate.metadata.labels?.['aether.dev/execution'] !== tenant || locks.has(id) || locks.size >= 8) continue;
          locks.add(id);
          try {
            // Re-read after acquiring the same lock used by commands; the list may be stale.
            const pod = await getPod(candidate.metadata.name, id);
            if (!pod || pod.metadata.deletionTimestamp) continue;
            const recorded = pod.metadata.annotations?.[activityAnnotation];
            // Older pods have no activity marker. Their creation time starts the deadline.
            const activity = /^\d+$/.test(recorded ?? '') ? Number(recorded) : Date.parse(pod.metadata.creationTimestamp);
            if (!Number.isSafeInteger(activity) || now() - activity < idleTimeoutSeconds * 1000) continue;
            await suspend(id, pod, true);
            result.suspended++;
          } catch {result.failed++;}
          finally {locks.delete(id);}
        }
        continuation = page.metadata?.continue ?? '';
      } while (continuation);
      return result;
    } finally {reconciling = false;}
  };
  const operation = async (id, body) => {
    const {name, metadata} = identity(id);
    let pod = await getPod(name, id);
    if (body.action === 'status') return status(pod);
    if (body.action === 'start') {
      const user = body.identity;
      if (body.environment !== 'rhel10' || !user || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user.username) || ['root', 'nobody'].includes(user.username)
          || !Number.isInteger(user.uid) || user.uid <= 0 || user.uid > 2147483647
          || !Number.isInteger(user.gid) || user.gid <= 0 || user.gid > 2147483647) throw new Error('Verified identity required');
      const fingerprint = JSON.stringify([user.username, user.uid, user.gid, 'rhel10', body.git?.providerId ?? null, body.git?.repository ?? null]);
      metadata.annotations['aether.dev/identity'] = fingerprint;
      const remote = body.git ? gitBroker.lease(id, body.git) : null;
      if (!body.git) gitBroker.revokeWorkspace(id);
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
      if (pvc.body.metadata.annotations?.['aether.dev/identity'] !== fingerprint
          || (pod && pod.metadata.annotations?.['aether.dev/identity'] !== fingerprint)) throw new Error('Workspace identity or repository changed; create a new chat');
      // A turn arriving during idle deletion must wait for the old pod, then resume its PVC.
      const deletionDeadline = Date.now() + 60000;
      while (pod?.metadata.deletionTimestamp) {
        await new Promise(resolve => setTimeout(resolve, 500));
        pod = await getPod(name, id);
        if (pod && pod.metadata.annotations?.['aether.dev/identity'] !== fingerprint) replyError();
        if (pod?.metadata.deletionTimestamp && Date.now() >= deletionDeadline) throw new Error('Workspace is still stopping');
      }
      if (!pod) {
        pod = await call('POST', `${base}/pods`, {apiVersion: 'v1', kind: 'Pod', metadata: {...metadata,
          annotations: {...metadata.annotations, [activityAnnotation]: String(now())}},
          spec: {automountServiceAccountToken: false, ...(runtimeClass ? {runtimeClassName: runtimeClass} : {}),
            restartPolicy: 'Always', terminationGracePeriodSeconds: 5, imagePullSecrets,
            securityContext: {runAsNonRoot: false, runAsUser: 0, runAsGroup: 0, fsGroup: user.gid, seccompProfile: {type: 'RuntimeDefault'}},
            containers: [{name: 'runner', image, imagePullPolicy,
              securityContext: {allowPrivilegeEscalation: true, readOnlyRootFilesystem: false, capabilities: {drop: ['ALL'], add: ['CHOWN', 'DAC_OVERRIDE', 'SETUID', 'SETGID', 'AUDIT_WRITE']}},
              env: [{name: 'AETHER_EXECUTION_USERNAME', value: user.username}, {name: 'AETHER_EXECUTION_UID', value: String(user.uid)}, {name: 'AETHER_EXECUTION_GID', value: String(user.gid)}],
              resources: {requests: {cpu: '250m', memory: '256Mi'}, limits: {cpu: '2', memory: '2Gi'}},
              readinessProbe: {exec: {command: ['node', '-e', "fetch('http://127.0.0.1:9006/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]}, periodSeconds: 5},
              volumeMounts: [{name: 'workspace', mountPath: '/workspace'}, {name: 'tmp', mountPath: '/tmp'}]}],
            volumes: [{name: 'workspace', persistentVolumeClaim: {claimName: name}}, {name: 'tmp', emptyDir: {sizeLimit: '1Gi'}}]}});
      }
      await touch(pod);
      if (remote && status(pod).state === 'ready') {
        const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
        const result = await call('POST', `${base}/pods/${name}:9006/proxy/operation`, {action: 'exec',
          command: `if [ -d repository/.git ]; then git -C repository remote set-url origin ${quote(remote)}; else git -c credential.helper= -c http.followRedirects=false clone -- ${quote(remote)} repository; fi`});
        if (result.exitCode !== 0 || result.timedOut) throw new Error('Repository checkout failed');
      }
      await touch(pod);
      return status(pod);
    }
    if (body.action === 'suspend') {
      await suspend(id, pod);
      return {state: pod ? 'stopping' : 'suspended'};
    }
    if (!['exec', 'read', 'write', 'list'].includes(body.action)) throw new Error('Unknown operation');
    if (status(pod).state !== 'ready') throw new Error('Workspace not ready');
    await touch(pod);
    try {return await call('POST', `${base}/pods/${name}:9006/proxy/operation`, body);}
    finally {await touch(pod);}
  };
  const server = createServer(async (request, response) => {
    const reply = (statusCode, body) => {response.writeHead(statusCode, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(body));};
    if (request.url === '/healthz' && request.method === 'GET') return reply(200, {ready: true});
    if (request.headers['x-aether-tenant'] !== tenant) return reply(403, {error: 'Execution access denied'});
    if (request.url === '/v1/git/providers' && request.method === 'GET') return reply(200, gitBroker.providers());
    const oauth = /^\/v1\/git\/oauth\/(begin|exchange|refresh|revoke)$/.exec(request.url);
    if (oauth && request.method === 'POST') {
      try {
        if (!gitBroker.oauth) throw new Error();
        return reply(200, await gitBroker.oauth[oauth[1]](await readJson(request, 16384)));
      } catch {return reply(400, {error: 'Git OAuth operation failed'});}
    }
    if (['/v1/git/verify', '/v1/git/revoke', '/v1/git/rotate'].includes(request.url) && request.method === 'POST') {
      try {
        const git = await readJson(request, 8192);
        if (request.url.endsWith('/verify')) return reply(200, await gitBroker.verify(git));
        if (typeof git.connectionId !== 'string') throw new Error();
        if (request.url.endsWith('/rotate')) gitBroker.rotate(git.connectionId);
        else gitBroker.revoke(git.connectionId);
        return reply(200, {});
      } catch {return reply(400, {error: 'Git connection operation failed'});}
    }
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
  // Kept off the HTTP API; reconciliation shares operation locks and only deletes owned pods.
  server.suspendIdleWorkspaces = suspendIdleWorkspaces;
  let idleTimer;
  const reconcile = async () => {
    try {
      if ((await suspendIdleWorkspaces()).failed) console.error('Idle workspace suspension failed; will retry');
    } catch {console.error('Idle workspace scan failed; will retry');}
  };
  server.on('listening', () => {
    if (!idleTimeoutSeconds) return;
    idleTimer = setInterval(reconcile, idleCheckIntervalMs);
    idleTimer.unref();
    void reconcile();
  });
  server.on('close', () => clearInterval(idleTimer));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const api = kubernetesClient({baseUrl: 'https://kubernetes.default.svc', credentials: '/var/run/aether-kubernetes'});
  const providers = JSON.parse(process.env.AETHER_EXECUTION_GIT_PROVIDERS || '[]');
  const clients = process.env.AETHER_EXECUTION_GIT_OAUTH_FILE ? JSON.parse(await readFile(process.env.AETHER_EXECUTION_GIT_OAUTH_FILE, 'utf8')) : {};
  const oauth = createGitOAuth({providers, clients, publicUrl: process.env.AETHER_EXECUTION_PUBLIC_URL});
  const gitBroker = createGitBroker({providers, oauth, publicUrl: process.env.AETHER_EXECUTION_GIT_URL});
  gitBroker.server.listen(9007, '0.0.0.0');
  createManager({gitBroker, imagePullSecrets: JSON.parse(process.env.AETHER_EXECUTION_IMAGE_PULL_SECRETS || '[]'), api, tenant: process.env.AETHER_TENANT_ID, namespace: process.env.AETHER_EXECUTION_NAMESPACE,
    image: process.env.AETHER_EXECUTION_IMAGE, storageClass: process.env.AETHER_EXECUTION_STORAGE_CLASS,
    imagePullPolicy: process.env.AETHER_EXECUTION_PULL_POLICY || 'IfNotPresent',
    idleTimeoutSeconds: Number(process.env.AETHER_EXECUTION_IDLE_TIMEOUT_SECONDS ?? '1800'),
    runtimeClass: process.env.AETHER_EXECUTION_RUNTIME_CLASS || 'kata'}).listen(9005, '127.0.0.1');
}
