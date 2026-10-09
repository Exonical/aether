import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';

const run = promisify(execFile);

/** Stop a test launcher and wait for inherited pipes/native file handles to close. */
export async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  if (process.platform === 'win32') {
    // Windows kill(SIGTERM) terminates the launcher without running its signal handlers.
    // workerd would survive with inherited pipes and open SQLite/KV directories.
    try {await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {timeout: 10000, windowsHide: true});}
    catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
    await closed;
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {await closed;} finally {clearTimeout(timer);}
}
