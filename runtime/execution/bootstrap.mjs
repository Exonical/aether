import {execFileSync} from 'node:child_process';
import {mkdir, chown, writeFile} from 'node:fs/promises';
import {createRunner} from './runner.mjs';

const username = process.env.AETHER_EXECUTION_USERNAME;
const uid = Number(process.env.AETHER_EXECUTION_UID), gid = Number(process.env.AETHER_EXECUTION_GID);
if (!username || !/^[a-z_][a-z0-9_-]{0,31}$/.test(username) || ['root', 'nobody'].includes(username)
    || !Number.isInteger(uid) || uid <= 0 || uid > 2147483647 || !Number.isInteger(gid) || gid <= 0 || gid > 2147483647) throw new Error('Verified POSIX identity required');
const run = (command, args) => execFileSync(command, args, {stdio: ['ignore', 'pipe', 'pipe']}).toString().trim();
let group;
try {group = run('getent', ['group', String(gid)]).split(':')[0];} catch {}
if (!group) {run('groupadd', ['--gid', String(gid), username]); group = username;}
let account;
try {account = run('getent', ['passwd', username]).split(':');} catch {}
if (account) {
  if (Number(account[2]) !== uid || Number(account[3]) !== gid) throw new Error('Container identity conflicts with image account');
} else {
  run('useradd', ['--uid', String(uid), '--gid', group, '--home-dir', '/workspace', '--no-create-home', '--shell', '/bin/bash', username]);
}
await mkdir('/workspace', {recursive: true});
await chown('/workspace', uid, gid);
await writeFile('/etc/sudoers.d/aether', `${username} ALL=(ALL:ALL) NOPASSWD: ALL\n`, {mode: 0o440});
run('visudo', ['-cf', '/etc/sudoers.d/aether']);
// Bootstrap is the only root process. All runner commands start as the actual signed-in user.
process.setgroups([gid]); process.setgid(gid); process.setuid(uid);
process.env.USER = username; process.env.LOGNAME = username; process.env.HOME = '/workspace';
(await createRunner({root: '/workspace'})).listen(9006, '0.0.0.0');
