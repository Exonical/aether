import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkspaceConfig } from "../../workspace-config.mjs";
import { createAdapter } from "../server.mjs";
import { readConfig } from "../config.mjs";
import { S3Client, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from "@aws-sdk/client-s3";

const require = createRequire(import.meta.url);
const probe = `export default { async fetch(req, env) {
  const u = new URL(req.url), key = u.searchParams.get('key') || 'object';
  if (u.pathname === '/multipart') {
    const upload = await env.DATA.createMultipartUpload(key);
    const a = await upload.uploadPart(1, new Uint8Array(6 * 1024 * 1024).fill(11));
    const b = await upload.uploadPart(2, new Uint8Array(1024).fill(22));
    await upload.complete([a,b]); return new Response('ok');
  }
  if (u.pathname === '/list') return Response.json(await env.DATA.list());
  if (req.method === 'PUT') {
    const value = await env.DATA.put(key, req.body, { customMetadata: { tenant: 'test' },
      ...(u.searchParams.has('onlyIf') ? { onlyIf: { etagMatches: 'wrong' } } : {}) });
    return Response.json(value);
  }
  if (req.method === 'DELETE') { await env.DATA.delete(key); return new Response('ok'); }
  if (req.method === 'HEAD') { const object = await env.DATA.head(key); return new Response(null, {status: object ? 200:404}); }
  const object = await env.DATA.get(key, req.headers.has('range') ? {range: req.headers} : {});
  return object ? new Response(object.body, {headers: {'x-tenant': object.customMetadata.tenant || ''}}) : new Response(null,{status:404});
}};`;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function harness(config, run) {
  const scratch = await mkdtemp(join(tmpdir(), "aether-s3-r2-"));
  const adapter = createAdapter(config);
  adapter.listen(0, "127.0.0.1"); await once(adapter, "listening");
  let child, output = "";
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timeout); }
  }
  try {
    const { binary, directories } = await createWorkspaceConfig({
      namespace: "aether-tenant-test", scratch, storage: "s3", assetManifest: {},
      workers: [
        { config: { name: "router", compatibility_date: "2026-09-04", services: [{ binding: "BACKEND", service: "workshop-backend" }] },
          modules: [{ name: "router.js", esModule: "export default {fetch(req,env){return env.BACKEND.fetch(req)}}" }] },
        { config: { name: "workshop-backend", compatibility_date: "2026-09-04", kv_namespaces: [{ binding: "BLUEPRINTS" }], r2_buckets: [{ binding: "DATA" }] },
          modules: [{ name: "probe.js", esModule: probe }] },
        ...["gatekeeper-context", "gatekeeper-scheduler"].map(name => ({
          config: { name, compatibility_date: "2026-09-04" },
          modules: [{ name: "stub.js", esModule: "import {WorkerEntrypoint} from 'cloudflare:workers'; export class GatekeeperVendor extends WorkerEntrypoint {} export default {fetch(){return new Response('stub')}}" }],
        })),
      ],
    });
    const file = join(scratch, "workspace.bin"); await writeFile(file, binary);
    await mkdir(join(scratch, "assets"));
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const args = ["serve", file, "--binary", "--experimental", `--socket-addr=http=127.0.0.1:${port}`,
      `--external-addr=aether:s3-endpoint=127.0.0.1:${adapter.address().port}`, `--directory-path=aether:assets-disk=${join(scratch, "assets")}`];
    for (const { service, subdirectory } of directories) {
      await mkdir(join(scratch, subdirectory), { recursive: true });
      args.push(`--directory-path=${service}=${join(scratch, subdirectory)}`);
    }
    async function start() {
      output = "";
      child = spawn(require("workerd").default, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, AETHER_ADMINS: "[]" } });
      child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
      for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(250) })).ok) return; } catch {}
        if (child.exitCode !== null) break;
        await delay(20);
      }
      throw new Error(`Native R2 probe failed to start: ${output}`);
    }
    await start();
    await run({ origin, adapterOrigin: `http://127.0.0.1:${adapter.address().port}`, restart: async () => { await stop(); await start(); }, scratch });
  } finally {
    await stop(); adapter.closeAllConnections(); await new Promise(resolve => adapter.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
}

test("native R2 never commits metadata when S3 rejects a write", async () => {
  const backend = createServer((req, res) => { req.resume(); res.writeHead(403).end(); });
  backend.listen(0, "127.0.0.1"); await once(backend, "listening");
  try {
    const config = await readConfig({ AWS_ENDPOINT_URL: `http://127.0.0.1:${backend.address().port}`,
      BUCKET_NAME: "test-bucket", AWS_DEFAULT_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
      AETHER_TENANT_ID: "test", AETHER_S3_ALLOW_HTTP: "true" });
    await harness(config, async ({ origin, adapterOrigin }) => {
      assert.equal((await fetch(`${origin}/object`, { method: "PUT", body: "must not persist" })).status, 500);
      assert.equal((await fetch(`${origin}/object`, { method: "HEAD" })).status, 404);
      assert.deepEqual((await (await fetch(`${origin}/list`)).json()).objects, []);
      const blob = "a".repeat(80);
      assert.equal((await fetch(`${adapterOrigin}/aether-tenant-other-DATA/blobs/${blob}`, { method: "PUT", body: "other" })).status, 403);
      assert.equal((await fetch(`${adapterOrigin}/aether-tenant-test-DATA/blobs/${blob}?list=1`)).status, 403);
      assert.equal((await fetch(`${adapterOrigin}/aether-tenant-test-DATA/blobs/${blob}`, { method: "POST" })).status, 405);
    });
  } finally { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});

test("native R2 stores streaming blobs on user-provided S3 and survives restart", { skip: !process.env.AETHER_TEST_S3_ENDPOINT, timeout: 120000 }, async () => {
  const config = await readConfig({ AWS_ENDPOINT_URL: process.env.AETHER_TEST_S3_ENDPOINT,
    BUCKET_NAME: `aether-test-${process.pid}`, AWS_DEFAULT_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: process.env.AETHER_TEST_S3_ACCESS_KEY || "aether-test",
    AWS_SECRET_ACCESS_KEY: process.env.AETHER_TEST_S3_SECRET_KEY || "aether-test-secret",
    AETHER_TENANT_ID: "test", AETHER_S3_ALLOW_HTTP: "true" });
  const client = new S3Client({ endpoint: config.endpoint, region: config.region, credentials: config.credentials,
    forcePathStyle: true, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  try {
    await harness(config, async ({ origin, restart, scratch }) => {
      const data = Buffer.alloc(20 * 1024 * 1024, 42); // Forces S3 multipart upload with bounded buffers.
      const put = await fetch(`${origin}/object`, { method: "PUT", body: data });
      assert.equal(put.status, 200, await put.clone().text());
      assert.equal((await put.json()).size, data.length);
      assert.equal((await fetch(`${origin}/object`, { method: "HEAD" })).status, 200);
      assert.deepEqual(Buffer.from(await (await fetch(`${origin}/object`)).arrayBuffer()), data);
      const range = await fetch(`${origin}/object`, { headers: { Range: "bytes=10-19" } });
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), data.subarray(10, 20));
      assert.equal(range.headers.get("x-tenant"), "test");
      await fetch(`${origin}/object?onlyIf=1`, { method: "PUT", body: "rejected" });
      assert.equal((await (await fetch(`${origin}/object`, { headers: { Range: "bytes=0-0" } })).arrayBuffer()).byteLength, 1);
      assert.equal((await fetch(`${origin}/multipart?key=multi`)).status, 200);
      const combined = Buffer.from(await (await fetch(`${origin}/object?key=multi`)).arrayBuffer());
      assert.equal(combined.length, 6 * 1024 * 1024 + 1024);
      assert.equal(combined[0], 11); assert.equal(combined.at(-1), 22);
      await restart();
      assert.deepEqual(Buffer.from(await (await fetch(`${origin}/object`)).arrayBuffer()), data);
      assert.equal((await (await fetch(`${origin}/list`)).json()).objects.length, 2);
      const remote = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }));
      assert.ok(remote.Contents.length >= 3);
      assert.ok(remote.Contents.every(object => object.Key.startsWith("aether/test/aether-tenant-test-")));
      const files = await readdir(join(scratch, "r2"), { recursive: true });
      assert.ok(!files.some(file => file.includes("blobs")), "R2 blobs must not be written to the local disk");
      await fetch(`${origin}/object`, { method: "DELETE" });
      assert.equal((await fetch(`${origin}/object`)).status, 404);
      assert.equal((await fetch(`${origin}/object?key=missing`)).status, 404);
    });
  } finally {
    const list = await client.send(new ListObjectsV2Command({ Bucket: config.bucket }));
    if (list.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: list.Contents.map(({ Key }) => ({ Key })) } }));
    await client.send(new DeleteBucketCommand({ Bucket: config.bucket }));
    client.destroy();
  }
});
