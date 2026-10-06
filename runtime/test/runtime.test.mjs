import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function reservePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

test("standalone runtime: service bindings, loader isolation, concurrent SQLite writes, restart persistence", async () => {
  const state = await mkdtemp(join(tmpdir(), "aether-runtime-"));
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let output = "";
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  async function start() {
    output = "";
    child = spawn(process.execPath, [join(root, "run.mjs")], {
      env: { ...process.env, AETHER_STATE_DIR: state, AETHER_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    let spawnError;
    child.on("error", error => { spawnError = error; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch { /* wait for socket startup */ }
      await delay(50);
    }
    throw new Error(`Runtime did not become ready: ${spawnError || output}`);
  }
  async function json(path, method = "GET") {
    const response = await fetch(`${origin}${path}`, { method, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}\n${output}`);
    return response.json();
  }
  try {
    await start();
    assert.deepEqual(await json("/healthz"), { status: "ok" });
    assert.equal((await json("/api/runtime")).cloudflareOSIntegrated, false);
    assert.equal((await json("/internal/probes/state")).value, 0);
    assert.deepEqual(await json("/internal/probes/worker", "POST"), {
      loaded: true, ambientNetworkDenied: true,
    });
    const writes = await Promise.all(Array.from({ length: 24 }, () => json("/internal/probes/state", "POST")));
    assert.deepEqual(writes.map(result => result.value).sort((a, b) => a - b),
      Array.from({ length: 24 }, (_, index) => index + 1));
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    assert.equal((await fetch(`${origin}/healthz`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/readyz`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/internal/probes/worker`)).status, 405);
    await stop();
    await start();
    assert.equal((await json("/internal/probes/state")).value, 24);
    assert.equal((await json("/internal/probes/state", "POST")).value, 25);
  } finally {
    await stop();
    await rm(state, { recursive: true, force: true });
  }
});
