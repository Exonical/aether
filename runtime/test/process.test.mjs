import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {stopProcess} from './process.mjs';

test('shutdown closes launcher and native descendant, including inherited pipes', {timeout: 20000}, async () => {
  const launcher = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const native = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
    process.on('SIGTERM', () => native.kill('SIGTERM'));
    native.on('close', () => process.exit(0));
    process.send({pid: native.pid});
  `], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  const [{pid}] = await once(launcher, 'message');
  try {
    await stopProcess(launcher);
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    assert.ok(launcher.exitCode !== null || launcher.signalCode !== null);
    await stopProcess(launcher); // Repeated cleanup after exit is harmless.
  } finally {
    try {process.kill(pid, 'SIGKILL');} catch {}
    await stopProcess(launcher);
  }
});
