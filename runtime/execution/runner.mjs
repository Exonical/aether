import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {realpath, open, mkdir, readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve, dirname, relative, isAbsolute} from 'node:path';
import {runGit, branchName} from './git-actions.mjs';

export async function readJson(request, limit = 600000) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** One runner belongs to exactly one isolated Linux pod and one persistent directory. */
export async function createRunner({root, timeoutMs = 60000, outputLimit = 1048576}) {
  await mkdir(root, {recursive: true}); root = await realpath(root);
  let busy = false;
  const confined = value => {
    const rel = relative(root, value);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path outside workspace');
    return value;
  };
  const filePath = async (path, writing = false) => {
    if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\0') || isAbsolute(path)) throw new Error('Invalid path');
    const target = confined(resolve(root, path));
    confined(await realpath(writing ? dirname(target) : target));
    return target;
  };
  const execute = command => new Promise((resolveResult, reject) => {
    if (typeof command !== 'string' || !command.trim() || command.length > 16384 || command.includes('\0')) return reject(new Error('Invalid command'));
    const child = spawn('/bin/sh', ['-lc', command], {cwd: root, detached: true,
      env: {PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: root, USER: process.env.USER || '', LOGNAME: process.env.LOGNAME || '', LANG: 'C.UTF-8'}, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', size = 0, truncated = false, timedOut = false, settled = false;
    const kill = () => {try {process.kill(-child.pid, 'SIGKILL');} catch {}};
    const finish = (exitCode, signal) => {
      if (settled) return; settled = true;
      clearTimeout(timer); kill(); child.stdout.destroy(); child.stderr.destroy();
      resolveResult({exitCode, signal, output, truncated, timedOut});
    };
    const timer = setTimeout(() => {timedOut = true; finish(null, 'SIGKILL');}, timeoutMs);
    const append = data => {
      const available = Math.max(0, outputLimit - size); size += data.length;
      output += data.subarray(0, available).toString('utf8');
      if (size > outputLimit) {truncated = true; finish(null, 'SIGKILL');}
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', error => {clearTimeout(timer); kill(); reject(error);});
    // Kill background children when the shell exits, before waiting for inherited output pipes.
    child.once('exit', kill);
    child.once('close', finish);
  });
  const operation = async body => {
    if (body.action === 'git-snapshot') {
      const cwd = await filePath('repository');
      if (!branchName(body.base)) throw new Error('Existing base branch required');
      const anchor = (await runGit(['rev-parse', '--verify', `refs/remotes/origin/${body.base}^{commit}`], {cwd})).toString().trim();
      const head = (await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], {cwd})).toString().trim();
      const pack = await runGit(['pack-objects', '--stdout', '--revs', '--window=0'], {cwd, input: `${head}\n^${anchor}\n`, limit: 2097152});
      return {head, anchor, pack: pack.toString('base64')};
    }
    if (body.action === 'exec') return execute(body.command);
    if (body.action === 'list') {
      const path = body.path === '.' ? root : await filePath(body.path);
      const entries = await readdir(path, {withFileTypes: true});
      return {entries: entries.slice(0, 200).map(e => ({name: e.name, directory: e.isDirectory()})), truncated: entries.length > 200};
    }
    if (body.action === 'read') {
      const handle = await open(await filePath(body.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Regular file required');
        const data = Buffer.alloc(524289); const {bytesRead} = await handle.read(data, 0, data.length, 0);
        if (bytesRead > 524288) throw new Error('File too large');
        return {content: data.subarray(0, bytesRead).toString('utf8')};
      } finally {await handle.close();}
    }
    if (body.action === 'write') {
      if (typeof body.content !== 'string' || Buffer.byteLength(body.content) > 524288) throw new Error('Invalid file content');
      const handle = await open(await filePath(body.path, true), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Regular file required');
        await handle.truncate(0); await handle.writeFile(body.content);
        return {written: true};
      } finally {await handle.close();}
    }
    throw new Error('Unknown operation');
  };
  return createServer(async (request, response) => {
    const reply = (status, body) => {response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(body));};
    if (request.url === '/healthz' && request.method === 'GET') return reply(200, {ready: true});
    if (request.url !== '/operation' || request.method !== 'POST') return reply(404, {error: 'Not found'});
    if (busy) return reply(429, {error: 'Workspace busy'});
    busy = true;
    try {reply(200, await operation(await readJson(request)));}
    catch {reply(400, {error: 'Workspace operation failed'});}
    finally {busy = false;}
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = await createRunner({root: '/workspace'});
  server.listen(9006, '0.0.0.0');
}
