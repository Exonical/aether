import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {randomBytes} from 'node:crypto';
import {gitProviders} from './git-providers.mjs';
import {createGitActions} from './git-actions.mjs';

const repositoryPath = value => typeof value === 'string' && value.length <= 256
  && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)+$/.test(value)
  && value.split('/').every(part => !part.endsWith('.git') && part !== '..');

/** Credentials stay in the controller. Execution pods can only fetch one selected repository. */
export function createGitBroker({providers = [], publicUrl, request = httpsRequest, now = Date.now, oauth, allowWrites = false, actions = createGitActions({request})}) {
  const approved = gitProviders(providers);
  const leases = new Map();
  const revoked = new Map();
  const prune = () => {
    for (const [id, lease] of leases) if (lease.expires <= now()) leases.delete(id);
    for (const [id, expires] of revoked) if (expires <= now()) revoked.delete(id);
  };
  const credentials = git => {
    const provider = approved.get(git?.providerId);
    if (!provider || typeof git.token !== 'string' || !git.token || git.token.length > 4096
        || [...git.token].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid Git connection');
    return provider;
  };
  const headers = (provider, git) => ({'user-agent': 'aether', accept: 'application/json',
    ...(provider.kind === 'gitlab' && git.authentication !== 'oauth' ? {'private-token': git.token} : {authorization: `Bearer ${git.token}`})});
  const verify = async git => {
    const provider = credentials(git);
    return new Promise((resolve, reject) => {
      const upstream = request(new URL('user', provider.api), {headers: headers(provider, git)}, response => {
        if (response.statusCode !== 200) {response.resume(); return reject(new Error('Git account verification failed'));}
        const chunks = []; let size = 0;
        response.on('data', chunk => {size += chunk.length; if (size > 65536) response.destroy(new Error('Git response too large')); else chunks.push(chunk);});
        response.on('error', reject);
        response.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks)); const login = provider.kind === 'gitlab' ? data.username : data.login;
            if (typeof login !== 'string' || !/^[a-zA-Z0-9_.@-]{1,100}$/.test(login)) throw new Error();
            resolve({login});
          } catch {reject(new Error('Invalid Git account'));}
        });
      });
      const timer = setTimeout(() => upstream.destroy(new Error('Git verification timeout')), 15000);
      upstream.once('close', () => clearTimeout(timer)); upstream.on('error', reject); upstream.end();
    });
  };
  const revokeWorkspace = workspace => {for (const [id, lease] of leases) if (lease.workspace === workspace) leases.delete(id);};
  const lease = (workspace, git) => {
    credentials(git);
    if (!repositoryPath(git.repository) || typeof git.connectionId !== 'string' || !publicUrl) throw new Error('Invalid repository selection');
    prune(); revokeWorkspace(workspace);
    if (revoked.has(git.connectionId)) throw new Error('Git connection revoked');
    if (leases.size >= 512) throw new Error('Git lease capacity exhausted');
    const id = randomBytes(32).toString('hex');
    leases.set(id, {...git, workspace, expires: now() + 600000});
    return new URL(`${id}/repository.git`, publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`).href;
  };
  const server = createServer((incoming, outgoing) => {
    prune();
    const match = /^\/([a-f0-9]{64})\/repository\.git\/(info\/refs\?service=git-upload-pack|git-upload-pack)$/.exec(incoming.url);
    const current = match && leases.get(match[1]);
    if (!current || (match[2].startsWith('info/') ? incoming.method !== 'GET' : incoming.method !== 'POST')) {outgoing.writeHead(403); outgoing.end(); return;}
    const provider = approved.get(current.providerId);
    const url = new URL(`${current.repository}.git/${match[2]}`, provider.url);
    // Smart HTTP read operations only. Never forward a client Authorization header or follow redirects.
    const authorization = 'Basic ' + Buffer.from(`${provider.kind === 'gitlab' ? 'oauth2' : 'x-access-token'}:${current.token}`).toString('base64');
    const upstream = request(url, {method: incoming.method, headers: {authorization, 'user-agent': 'aether',
      ...(incoming.method === 'POST' ? {'content-type': 'application/x-git-upload-pack-request'} : {}),
      ...(incoming.headers['git-protocol'] ? {'git-protocol': String(incoming.headers['git-protocol']).slice(0, 128)} : {})}}, response => {
      if (response.statusCode !== 200) {response.resume(); outgoing.writeHead(502); outgoing.end(); return;}
      outgoing.writeHead(200, {'content-type': match[2].startsWith('info/') ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result', 'cache-control': 'no-store'});
      let size = 0;
      response.on('data', chunk => {size += chunk.length; if (size > 268435456) response.destroy(new Error('Repository too large'));});
      response.on('error', () => outgoing.destroy()); response.pipe(outgoing);
    });
    let size = 0;
    incoming.on('data', chunk => {size += chunk.length; if (size > 2097152) upstream.destroy(new Error('Git request too large'));});
    const timer = setTimeout(() => upstream.destroy(new Error('Git transfer timeout')), 120000);
    upstream.once('close', () => clearTimeout(timer));
    upstream.on('error', () => {if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end();});
    outgoing.on('close', () => upstream.destroy()); incoming.pipe(upstream);
  });
  let actionInFlight = false;
  const action = async (operation, {workspace, git, action: payload}) => {
    prune();
    const provider = credentials(git);
    if (!allowWrites || typeof git.connectionId !== 'string' || !git.connectionId || git.connectionId.length > 64 || revoked.has(git.connectionId) || !repositoryPath(git.repository)) throw new Error('Git writes are disabled or revoked');
    if (actionInFlight) throw new Error('Git controller busy');
    actionInFlight = true;
    try {return await actions[operation](provider, git, workspace, payload, () => {prune(); if (revoked.has(git.connectionId)) throw new Error('Git connection revoked');});}
    finally {actionInFlight = false;}
  };
  return {server, verify, lease, revokeWorkspace,
    prepareAction: body => action('prepare', body), applyAction: body => action('apply', body),
    rotate: connectionId => {for (const [id, item] of leases) if (item.connectionId === connectionId) leases.delete(id);},
    oauth,
    providers: () => [...approved.values()].map(({id, label, kind}) => ({id, label, kind, ...(oauth?.enabled(id) ? {oauth: true} : {})})),
    revoke: connectionId => {
      prune();
      if (revoked.size >= 4096) throw new Error('Git revocation capacity exhausted');
      revoked.set(connectionId, now() + 600000);
      for (const [id, item] of leases) if (item.connectionId === connectionId) leases.delete(id);
    },
  };
}
