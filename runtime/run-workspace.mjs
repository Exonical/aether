import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.env.AETHER_BUILD_DIR || join(root, "dist/workspace"));
const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1) throw new Error("Unsupported workspace artifact schema");
const storage = process.env.AETHER_BLOB_STORAGE || "local";
const kvStorage = process.env.AETHER_KV_STORAGE || "local";
if (!["local", "s3"].includes(storage)) throw new Error("AETHER_BLOB_STORAGE must be local or s3");
if (!["local", "postgres"].includes(kvStorage)) throw new Error("AETHER_KV_STORAGE must be local or postgres");
if (storage === "s3" && (!manifest.tenantId || !manifest.blobStorageModes?.includes("s3"))) throw new Error("S3 requires an artifact built with AETHER_TENANT_ID");
if (kvStorage === "postgres" && (!manifest.tenantId || !manifest.kvStorageModes?.includes("postgres"))) throw new Error("PostgreSQL KV requires a tenant artifact with PostgreSQL support");
if (process.env.AETHER_TENANT_ID && process.env.AETHER_TENANT_ID !== manifest.tenantId) throw new Error("Artifact tenant identity mismatch");
if (manifest.oidc) {
  const url = new URL(process.env.AETHER_PUBLIC_URL);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || (url.protocol === "http:" && process.env.AETHER_OIDC_ALLOW_HTTP !== "true")) throw new Error("Invalid AETHER_PUBLIC_URL (HTTP requires explicit development opt-in)");
  process.env.AETHER_PUBLIC_URL = url.origin;
  process.env.AETHER_OIDC_DISPLAY_NAME ||= "Single sign-on";
  process.env.AETHER_OIDC_SESSION_TTL ||= "28800";
  const ttl = Number(process.env.AETHER_OIDC_SESSION_TTL);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error("OIDC session TTL must be 60–86400 seconds");
  if (!process.env.AETHER_ADMINS) throw new Error("OIDC requires explicit AETHER_ADMINS verified email list (or [])");
}
const state = resolve(process.env.AETHER_STATE_DIR || join(root, ".workspace-state"));
const port = process.env.AETHER_PORT || "8080";
const bindAddress=process.env.AETHER_BIND_ADDRESS || "127.0.0.1";
if (!["127.0.0.1", "0.0.0.0"].includes(bindAddress)) throw new Error("Invalid AETHER_BIND_ADDRESS");
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid AETHER_PORT");
const file = kvStorage === "postgres" ? (storage === "s3" ? "workspace-postgres-s3.capnp.bin" : "workspace-postgres.capnp.bin")
  : (storage === "s3" ? "workspace-s3.capnp.bin" : "workspace.capnp.bin");
const args = ["serve", join(output, file), "--binary", "--experimental", `--socket-addr=http=${bindAddress}:${port}`,
  `--directory-path=aether:assets-disk=${join(output, "assets")}`];
if (storage === "s3") args.push(`--external-addr=aether:s3-endpoint=127.0.0.1:${process.env.AETHER_S3_PORT || "9001"}`);
if (kvStorage === "postgres") args.push(`--external-addr=aether:postgres-endpoint=127.0.0.1:${process.env.AETHER_PG_ADAPTER_PORT || "9002"}`);
if (manifest.oidc) args.push(`--external-addr=aether:oidc-endpoint=127.0.0.1:${process.env.AETHER_OIDC_PORT || "9004"}`);
if (manifest.modelGateway) args.push(`--external-addr=aether:model-endpoint=127.0.0.1:${process.env.AETHER_MODEL_PORT || "9003"}`);
for (const { service, subdirectory } of manifest.directories) {
  const path = join(state, subdirectory);
  await mkdir(path, { recursive: true });
  args.push(`--directory-path=${service}=${path}`);
}
const workerd = createRequire(import.meta.url)("workerd").default;
const child = spawn(workerd, args, { stdio: "inherit", env: { ...process.env, AETHER_ADMINS: process.env.AETHER_ADMINS || '["admin"]' } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
