import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdapter } from "../server.mjs";
import { readConfig } from "../config.mjs";

test("S3 transport validates TLS and trusts only the configured internal CA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aether-s3-tls-"));
  let backend;
  const adapters = [];
  try {
    const cert = join(directory, "cert.pem"), key = join(directory, "key.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
    let calls = 0;
    backend = createServer({ cert: await readFile(cert), key: await readFile(key) }, (request, response) => {
      calls++;
      assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test\//);
      assert.ok(request.url.startsWith("/test-bucket/aether/test/aether-tenant-test-"));
      request.resume();
      request.on("end", () => response.writeHead(200, { ETag: '"test-etag"' }).end());
    });
    backend.listen(0, "127.0.0.1"); await once(backend, "listening");
    const env = { AWS_ENDPOINT_URL: `https://127.0.0.1:${backend.address().port}`, BUCKET_NAME: "test-bucket",
      AWS_DEFAULT_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test-secret", AETHER_TENANT_ID: "test" };
    for (const trust of [false, true]) {
      const config = await readConfig({ ...env, ...(trust ? { AETHER_S3_CA_FILE: cert } : {}) });
      const adapter = createAdapter(config); adapters.push(adapter);
      adapter.listen(0, "127.0.0.1"); await once(adapter, "listening");
      const result = await fetch(`http://127.0.0.1:${adapter.address().port}/aether-tenant-test-DATA/blobs/${"a".repeat(80)}`, { method: "PUT", body: "test TLS" });
      assert.equal(result.status, trust ? 204 : 502);
    }
    assert.equal(calls, 1, "untrusted connections must not reach S3 request processing");
  } finally {
    for (const adapter of adapters) { adapter.closeAllConnections(); await new Promise(resolve => adapter.close(resolve)); }
    if (backend) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  }
});
