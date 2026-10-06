import { createServer } from "node:http";
import { Agent } from "node:https";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { readConfig } from "./config.mjs";

/** Private BlobStore-to-S3 bridge. Bind only to loopback in the tenant's pod. */
export function createAdapter(config) {
  const client = new S3Client({
    endpoint: config.endpoint, region: config.region, credentials: config.credentials,
    forcePathStyle: config.forcePathStyle, followRegionRedirects: false, maxAttempts: 3,
    // Optional SDK checksum extensions are not consistently supported by S3 implementations.
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 5000, requestTimeout: 120000,
      httpsAgent: new Agent({ keepAlive: true, ...(config.ca ? { ca: config.ca } : {}) }),
    }),
  });
  const namespacePrefix = `aether-tenant-${config.tenantId}-`;
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz" && request.method === "GET") {
      response.writeHead(200).end("ok");
      return;
    }
    // Match the raw path before URL normalization; listing and arbitrary keys are unavailable.
    const match = /^\/([^/?]+)\/blobs\/([a-f0-9]{80})$/.exec(request.url || "");
    let namespace;
    try { namespace = match && decodeURIComponent(match[1]); } catch { /* Invalid encoding. */ }
    if (!namespace?.startsWith(namespacePrefix) || !/^[a-zA-Z0-9_-]+$/.test(namespace)) {
      request.resume();
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (!["GET", "HEAD", "PUT", "DELETE"].includes(request.method)) {
      request.resume();
      response.writeHead(405, { Allow: "GET, HEAD, PUT, DELETE" }).end();
      return;
    }
    const controller = new AbortController();
    response.on("close", () => { if (!response.writableEnded) controller.abort(); });
    const params = { Bucket: config.bucket, Key: `${config.prefix}${namespace}/blobs/${match[2]}` };
    try {
      if (request.method === "PUT") {
        // Bounded multipart buffering (2 x 8 MiB), including unknown-length workerd streams.
        const upload = new Upload({ client, params: { ...params, Body: request },
          queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
        const abort = () => { void upload.abort().catch(() => {}); };
        controller.signal.addEventListener("abort", abort, { once: true });
        request.once("aborted", abort);
        try { await upload.done(); } finally {
          controller.signal.removeEventListener("abort", abort);
          request.off("aborted", abort);
        }
        response.writeHead(204).end();
      } else if (request.method === "DELETE") {
        await client.send(new DeleteObjectCommand(params), { abortSignal: controller.signal });
        response.writeHead(204).end();
      } else {
        const range = request.headers.range;
        if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
          response.writeHead(416).end();
          return;
        }
        const Command = request.method === "HEAD" ? HeadObjectCommand : GetObjectCommand;
        const object = await client.send(new Command({ ...params, ...(range ? { Range: range } : {}) }), { abortSignal: controller.signal });
        const headers = { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes" };
        if (object.ContentLength !== undefined) headers["Content-Length"] = String(object.ContentLength);
        if (object.ContentRange) headers["Content-Range"] = object.ContentRange;
        if (object.ETag) headers.ETag = object.ETag;
        response.writeHead(object.ContentRange ? 206 : 200, headers);
        if (request.method === "HEAD") response.end();
        else await pipeline(object.Body, response);
      }
    } catch (error) {
      // Never log SDK error bodies, endpoint URLs, request headers, or credentials.
      const status = error.$metadata?.httpStatusCode;
      if (response.headersSent) response.destroy();
      else response.writeHead(status === 404 ? 404 : status === 416 ? 416 : 502).end("Object storage request failed");
      if (status !== 404 && status !== 416 && !controller.signal.aborted) {
        console.error(JSON.stringify({ event: "s3.request.failed", method: request.method, status: status || 0 }));
      }
      request.resume();
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  server.on("close", () => client.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await readConfig();
  const server = createAdapter(config);
  server.listen(config.port, "127.0.0.1", () => console.log("Aether S3 adapter listening on loopback"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    server.close();
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 25000);
    timeout.unref();
  });
}
