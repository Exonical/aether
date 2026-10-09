import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {request as httpsRequest} from 'node:https';

export const branchName = value => typeof value === 'string' && value.length <= 200
  && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) && !value.includes('..') && !value.includes('//')
  && value.split('/').every(part => part && !part.endsWith('.') && !part.endsWith('.lock'));
const oid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const fail = () => {throw new Error('Git action refused');};

/** Fixed git invocations in a disposable controller repository. Never executes sandbox hooks. */
export function runGit(args, {cwd, input, env = {}, limit = 4194304} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'http.followRedirects=false', '-c', 'credential.helper=', ...args], {cwd, detached: true,
      env: {PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
        ...(process.env.NODE_EXTRA_CA_CERTS ? {GIT_SSL_CAINFO: process.env.NODE_EXTRA_CA_CERTS} : {}), ...env}, stdio: ['pipe', 'pipe', 'pipe']});
    const chunks = []; let size = 0;
    const kill = () => {try {process.kill(-child.pid, 'SIGKILL');} catch {}};
    const timer = setTimeout(kill, 60000);
    child.stdout.on('data', chunk => {size += chunk.length; if (size > limit) kill(); else chunks.push(chunk);});
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => {clearTimeout(timer); kill(); reject(new Error('Git action failed'));});
    child.on('close', code => {clearTimeout(timer); kill(); if (code !== 0 || size > limit) reject(new Error('Git action failed')); else resolve(Buffer.concat(chunks));});
    child.stdin.end(input);
  });
}

/** Private write transport: fixed repository, task branch, immutable pack and optimistic concurrency. */
export function createGitActions({request = httpsRequest, remote = (provider, git) => new URL(`${git.repository}.git`, provider.url).href} = {}) {
  const json = (provider, git, path, method = 'GET', body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const upstream = request(new URL(path, provider.api), {method, headers: {'user-agent': 'aether', accept: 'application/json',
      ...(provider.kind === 'gitlab' && git.authentication !== 'oauth' ? {'private-token': git.token} : {authorization: `Bearer ${git.token}`}),
      ...(data ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {})}}, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => {size += chunk.length; if (size > 1048576) response.destroy(new Error('Git response too large')); else chunks.push(chunk);});
      response.on('error', () => reject(new Error('Git action failed')));
      response.on('end', () => {try {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error('Git action failed'));
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {reject(new Error('Git action failed'));}});
    });
    upstream.setTimeout(15000, () => upstream.destroy()); upstream.on('error', () => reject(new Error('Git action failed'))); upstream.end(data);
  });
  const validate = (workspace, action) => {
    if (!/^[a-f0-9]{64}$/.test(workspace) || !action || !['push', 'pull-request'].includes(action.action)
        || !branchName(action.branch) || !action.branch.startsWith(`aether/${workspace.slice(0, 32)}/`) || !branchName(action.base)
        || action.branch === action.base) fail();
    if (action.action === 'pull-request' && (typeof action.title !== 'string' || !action.title.trim() || action.title.length > 256
        || typeof action.body !== 'string' || action.body.length > 16384)) fail();
  };
  const withRepository = async (provider, git, action, callback) => {
    if (!oid(action.head) || !oid(action.anchor) || typeof action.pack !== 'string' || action.pack.length > 2796204
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(action.pack)) fail();
    const pack = Buffer.from(action.pack, 'base64');
    if (pack.length > 2097152 || pack.subarray(0, 4).toString() !== 'PACK') fail();
    const cwd = await mkdtemp(join(tmpdir(), 'aether-approved-git-'));
    const authorization = 'Basic ' + Buffer.from(`${provider.kind === 'gitlab' ? 'oauth2' : 'x-access-token'}:${git.token}`).toString('base64');
    const options = {cwd, env: {GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`}};
    const run = (args, input) => runGit(args, {...options, input});
    try {
      await run(['init', '--bare', '.']);
      // Remote refs and ancestry are verified outside the untrusted sandbox, including at approval time.
      const url = remote(provider, git);
      await run(['fetch', '--no-tags', '--depth=256', '--', url, `refs/heads/${action.base}:refs/heads/base`]);
      const base = (await run(['rev-parse', 'refs/heads/base'])).toString().trim();
      // Establish the anchor on the real remote before importing any sandbox objects.
      await run(['merge-base', '--is-ancestor', action.anchor, base]);
      const anchorCommit = (await run(['cat-file', 'commit', action.anchor])).toString('base64');
      if (anchorCommit.length > 65536) fail();
      await run(['index-pack', '--stdin', '--strict'], pack);
      if ((await run(['cat-file', '-t', action.head])).toString().trim() !== 'commit') fail();
      const refs = (await run(['ls-remote', '--refs', '--', url, `refs/heads/${action.branch}`])).toString().trim();
      const old = refs ? refs.split(/\s/)[0] : '0'.repeat(40);
      if (!oid(old)) fail();
      if (old !== '0'.repeat(40)) await run(['fetch', '--no-tags', '--', url, `refs/heads/${action.branch}:refs/heads/target`]);
      await run(['merge-base', '--is-ancestor', old === '0'.repeat(40) ? base : old, action.head]);
      return await callback({run, url, old, base, anchorCommit, sha256: createHash('sha256').update(pack).digest('hex'), size: pack.length});
    } finally {await rm(cwd, {recursive: true, force: true});}
  };
  return {
    prepare: async (provider, git, workspace, action) => {
      validate(workspace, action);
      if (action.action === 'pull-request') return {action: action.action, branch: action.branch, base: action.base, title: action.title, body: action.body};
      return withRepository(provider, git, action, ({old, base, anchorCommit, sha256, size}) => ({action: 'push', branch: action.branch, base: action.base,
        head: action.head, anchor: action.anchor, anchorCommit, pack: action.pack, old, baseHead: base, sha256, size}));
    },
    apply: async (provider, git, workspace, action, assertActive = () => {}) => {
      validate(workspace, action);
      if (action.action === 'push') return withRepository(provider, git, action, async ({run, url, old, sha256}) => {
        if (sha256 !== action.sha256 || old !== action.old && old !== action.head) fail();
        assertActive();
        if (old !== action.head) await run(['push', '--porcelain', `--force-with-lease=refs/heads/${action.branch}:${old === '0'.repeat(40) ? '' : old}`,
          '--', url, `${action.head}:refs/heads/${action.branch}`]);
        return {head: action.head, branch: action.branch};
      });
      const project = provider.kind === 'gitlab' ? `projects/${encodeURIComponent(git.repository)}`
        : `repos/${git.repository.split('/').map(encodeURIComponent).join('/')}`;
      const path = provider.kind === 'gitlab' ? `${project}/merge_requests` : `${project}/pulls`;
      const query = provider.kind === 'gitlab' ? new URLSearchParams({state: 'opened', source_branch: action.branch, target_branch: action.base, per_page: '100'})
        : new URLSearchParams({state: 'open', head: `${git.repository.split('/')[0]}:${action.branch}`, base: action.base, per_page: '100'});
      const existing = await json(provider, git, `${path}?${query}`);
      if (!Array.isArray(existing) || existing.length >= 100) fail();
      const same = existing.find(item => provider.kind === 'gitlab'
        ? item.source_branch === action.branch && item.target_branch === action.base && item.source_project_id === item.target_project_id
        : item.head?.ref === action.branch && item.base?.ref === action.base && item.head?.repo?.full_name === git.repository);
      if (same && (same.title !== action.title || (provider.kind === 'gitlab' ? same.description : same.body) !== action.body)) fail();
      assertActive();
      const result = same || await json(provider, git, path, 'POST', provider.kind === 'gitlab'
        ? {source_branch: action.branch, target_branch: action.base, title: action.title, description: action.body, remove_source_branch: false}
        : {head: action.branch, base: action.base, title: action.title, body: action.body, maintainer_can_modify: false});
      const url = new URL(provider.kind === 'gitlab' ? result.web_url : result.html_url);
      if (url.origin !== provider.url.origin || url.username || url.password) fail();
      return {url: url.href};
    },
  };
}
