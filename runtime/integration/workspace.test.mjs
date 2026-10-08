import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("real upstream workspace: assets, password accounts, Gatekeepers, KV, R2, DO restart and account isolation", { timeout: 60000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), "aether-workspace-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  let postgresAdapter, postgresPort;
  let executionFixture;
  let output = "";
  let starts = 0;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  async function start() {
    output = "";
    child = spawn(process.execPath, [join(root, "run-workspace.mjs")], {
      env: { ...process.env, AETHER_STATE_DIR: state, AETHER_PORT: String(port), AETHER_ADMINS: '["admin"]',
        AETHER_EXECUTION_ENABLED: executionFixture ? 'true' : 'false',
        ...(postgresPort ? { AETHER_PG_ADAPTER_PORT: String(postgresPort) } : {}),
        ...(starts++ === 0 && process.env.AETHER_TEST_PREVIOUS_BUILD_DIR
          ? { AETHER_BUILD_DIR: process.env.AETHER_TEST_PREVIOUS_BUILD_DIR } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        if ((await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(500) })).ok) return;
      } catch { /* wait for native runtime startup */ }
      await delay(50);
    }
    throw new Error(`Workspace did not become ready: ${output}`);
  }
  async function rpc(callback) {
    const api = newHttpBatchRpcSession(`${origin}/api`);
    try { return await callback(api); } finally { api[Symbol.dispose](); }
  }
  try {
    if (process.env.AETHER_TEST_EXECUTION === 'true') {
      const {createExecutionFixture} = await import('../execution/test/fixture.mjs');
      executionFixture = await createExecutionFixture(join(state, 'linux'));
    }
    if (process.env.AETHER_KV_STORAGE === "postgres") {
      const { createAdapter } = await import("../postgres/server.mjs");
      const { readConfig } = await import("../postgres/config.mjs");
      postgresAdapter = await createAdapter(await readConfig());
      postgresAdapter.listen(0, "127.0.0.1");
      await once(postgresAdapter, "listening");
      postgresPort = postgresAdapter.address().port;
    }
    await start();
    const response = await fetch(origin);
    assert.equal(response.status, 200, output);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /<script/);
    const assetPath = html.match(/src="([^"]+\.js)"/)[1];
    const asset = await fetch(`${origin}${assetPath}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(`${origin}${assetPath}`, { headers: { "If-None-Match": asset.headers.get("etag") } })).status, 304);
    assert.equal((await fetch(`${origin}${assetPath}`, { method: "HEAD" })).status, 200);
    assert.equal((await fetch(`${origin}/admin`)).status, 200);
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);

    const passwordHash = new Uint8Array(32).fill(42); // Synthetic password hash; no real credentials.
    const adminToken = await rpc(api => api.createAccount("admin", "Aether Admin", passwordHash));
    assert.equal(typeof adminToken, "string");
    const websocket = new WebSocket(`${origin.replace("http:", "ws:")}/api`);
    const wsApi = newWebSocketRpcSession(websocket);
    try {
      const user = await wsApi.authenticate(adminToken);
      try { assert.equal((await user.whoami()).name, "Aether Admin"); }
      finally { user[Symbol.dispose](); }
    } finally {
      wsApi[Symbol.dispose]();
      websocket.close();
    }
    assert.equal(await rpc(api => api.login("admin", new Uint8Array(32).fill(7))), null);
    assert.equal((await rpc(api => api.authenticate(adminToken).whoami())).name, "Aether Admin");
    await rpc(api => api.authenticate(adminToken).setOwnDisplayName("Persistent Admin"));
    const vendors = await rpc(api => api.authenticate(adminToken).listAddableGatekeepers());
    assert.deepEqual(vendors.map(vendor => vendor.id).sort(), ["context", "scheduler"]);
    await rpc(api => api.authenticate(adminToken).provisionAmbientAccount("context"));
    await rpc(api => api.authenticate(adminToken).provisionAmbientAccount("scheduler"));
    assert.deepEqual(await rpc(api => api.authenticate(adminToken).listAddableGatekeepers()), []);
    await rpc(api => api.authenticate(adminToken).getAdminApi().setSiteName("Aether Integration"));
    const workspace = await rpc(api => api.authenticate(adminToken).newGadget().getMetadata());
    await rpc(api => api.authenticate(adminToken).openGadget(workspace.id).setTitle("Persistent workspace"));
    const avatar = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64"));
    await rpc(api => api.authenticate(adminToken).setAvatar(avatar));
    assert.deepEqual(new Uint8Array(await rpc(api => api.authenticate(adminToken).getAvatar("admin"))), avatar);
    const otherToken = await rpc(api => api.createAccount("other", "Other User", passwordHash));
    assert.equal(await rpc(api => api.authenticate(otherToken).getAdminApi()), null);
    await assert.rejects(rpc(api => api.authenticate(otherToken).openGadget(workspace.id).getMetadata()), /access|permission|not found/i);
    // Bundled format installation exercises binary Blueprint content through native R2 bindings.
    let blueprint;
    for (let attempt = 0; attempt < 30; attempt++) {
      blueprint = await rpc(api => api.getBlueprint("format.document"));
      if (blueprint) break;
      await delay(100);
    }
    assert.ok(blueprint, `Format Blueprint failed to install: ${output}`);
    const fromBlueprint = await rpc(api => api.authenticate(adminToken).newGadgetFromBlueprint("format.document", {}).getMetadata());
    assert.equal(fromBlueprint.title, "Workspace Docs");
    await stop();
    await start();
    const login = await rpc(api => api.login("admin", passwordHash));
    assert.equal(typeof login, "string");
    assert.equal((await rpc(api => api.authenticate(login).whoami())).name, "Persistent Admin");
    assert.equal((await rpc(api => api.authenticate(login).openGadget(workspace.id).getMetadata())).title, "Persistent workspace");
    assert.deepEqual(new Uint8Array(await rpc(api => api.authenticate(login).getAvatar("admin"))), avatar);
    assert.equal((await rpc(api => api.authenticate(login).getAdminApi().getSettings())).siteName, "Aether Integration");
    assert.ok(await rpc(api => api.getBlueprint("format.document")));
    assert.equal((await rpc(api => api.authenticate(login).openGadget(fromBlueprint.id).getMetadata())).title, "Workspace Docs");
    // Read the persisted R2 content again after restart, rather than only its KV metadata.
    assert.equal((await rpc(api => api.authenticate(login).newGadgetFromBlueprint("format.document", {}).getMetadata())).title, "Workspace Docs");
    const manifest = JSON.parse(await readFile(join(root, "dist/workspace/manifest.json"), "utf8"));
    assert.deepEqual(manifest.workers, ["router", "workshop-backend", "gatekeeper-context", "gatekeeper-scheduler"]);
    if (executionFixture) {
      const profile = await rpc(api => api.authenticate(login).getExecutionProfile());
      assert.equal(profile.identity, null);
      const chatId = await rpc(api => api.authenticate(login).openGadget(workspace.id).newChat('Ask only', null));
      const calls = executionFixture.calls.length;
      await assert.rejects(rpc(api => api.authenticate(login).openGadget(workspace.id).executionWorkspace({action: 'start'}, chatId)), /Agent/i);
      await assert.rejects(rpc(api => api.authenticate(login).openGadget(workspace.id).newChat('Agent denied', null, undefined, undefined, undefined, {mode: 'agent', environment: 'rhel10'})), /identity provider|UID/i);
      await assert.rejects(rpc(api => api.authenticate('forged').openGadget(workspace.id).executionWorkspace({action: 'start'}, chatId)), /session|token|auth/i);
      assert.equal(executionFixture.calls.length, calls);
    }
  } catch (error) {
    error.message += `\nNative workspace logs:\n${output}`;
    throw error;
  } finally {
    await stop();
    if (executionFixture) await executionFixture.close();
    if (postgresAdapter) {
      postgresAdapter.closeAllConnections();
      await new Promise(resolve => postgresAdapter.close(resolve));
    }
    await rm(state, { recursive: true, force: true });
  }
});
