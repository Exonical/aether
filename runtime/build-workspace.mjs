import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import { collectModules, collectAssets } from "../cloudflare-os/scripts/release/hash-lib.ts";
import { resolveBinEntry } from "../cloudflare-os/scripts/bin-entry.ts";
import { createWorkspaceConfig, validateWorkerConfig } from "./workspace-config.mjs";

const runtime = dirname(fileURLToPath(import.meta.url));
const upstream = resolve(runtime, "../cloudflare-os");
const output = resolve(process.env.AETHER_BUILD_DIR || join(runtime, "dist/workspace"));
const packageNames = ["router", "workshop-backend", "gatekeeper-context", "gatekeeper-scheduler"];
const configs = [];
for (const name of packageNames) {
  const errors = [];
  const config = parse(await readFile(join(upstream, "packages", name, "wrangler.jsonc"), "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`${name}: ${errors.map(error => printParseErrorCode(error.error)).join(", ")}`);
  validateWorkerConfig(config);
  if (config.name !== name) throw new Error(`Unexpected upstream identity ${config.name}`);
  configs.push(config);
}
function runNode(file, args, cwd) {
  execFileSync(process.execPath, [file, ...args], { cwd, stdio: "inherit", env: {
    ...process.env, VITE_CF_ACCESS_MODE: "false",
    WRANGLER_SEND_METRICS: "false", WRANGLER_SEND_ERROR_REPORTS: "false", DO_NOT_TRACK: "1",
  } });
}
function runBin(name, args, cwd) {
  const entry = name === "typescript" ? join(upstream, "node_modules/typescript/bin/tsc")
    : resolveBinEntry(cwd, name) || resolveBinEntry(upstream, name);
  if (!entry) throw new Error(`Missing ${name}; run pnpm --dir cloudflare-os install --frozen-lockfile`);
  runNode(entry, args, cwd);
}

// Invoke the actual compilers directly. Vite+'s task IPC and development watchers are not needed.
runBin("typescript", [], join(upstream, "packages/typed-storage"));
runBin("vite", ["build"], join(upstream, "packages/workshop-frontend"));
for (const name of ["gatekeeper-context", "gatekeeper-scheduler"]) {
  const cwd = join(upstream, "packages", name);
  runNode(join(cwd, "build-app.mjs"), [], cwd);
}
const backend = join(upstream, "packages/workshop-backend");
runNode(join(backend, "scripts/build-format-blueprints.mjs"), [], backend);
const scratch = await mkdtemp(join(tmpdir(), "aether-build-"));
try {
  const workers = [];
  for (const config of configs) {
    const cwd = join(upstream, "packages", config.name);
    const outdir = join(scratch, config.name);
    // Wrangler is a bundler here only; it neither serves nor deploys this workspace.
    runBin("wrangler", ["deploy", "--dry-run", "--outdir", outdir], cwd);
    const { mainModule, modules } = collectModules(outdir);
    const fields = { esm: "esModule", text: "text", wasm: "wasm", data: "data" };
    workers.push({ config, modules: modules.toSorted((a, b) => (a.name === mainModule ? -1 : b.name === mainModule ? 1 : 0)).map(module => ({
      name: module.name,
      [fields[module.type]]: ["wasm", "data"].includes(module.type) ? module.bytes : module.bytes.toString("utf8"),
    })) });
  }
  const frontend = join(upstream, "packages/workshop-frontend/dist");
  const { manifest, blobs } = collectAssets(frontend);
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json" };
  const assetManifest = Object.fromEntries(Object.entries(manifest).map(([path, asset]) => [path, {
    size: asset.size, sha256: createHash("sha256").update(blobs.get(asset.hash).bytes).digest("hex"),
    contentType: types[extname(path)] || "application/octet-stream",
  }]));
  const namespace = "aether-workspace-v1";
  const { binary, directories, config } = await createWorkspaceConfig({ workers, assetManifest, namespace, scratch });
  await mkdir(output, { recursive: true });
  await rm(join(output, "assets"), { recursive: true, force: true });
  await cp(frontend, join(output, "assets"), { recursive: true });
  await writeFile(join(output, "workspace.capnp.bin"), binary);
  await writeFile(join(output, "manifest.json"), JSON.stringify({
    schemaVersion: 1, namespace,
    upstreamCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim(),
    workerdVersion: "1.20261006.1", storageWorkersVersion: "5.20260801.1-alpha",
    workers: workers.map(({ config }) => config.name), directories,
    durableObjects: config.services.flatMap(service => (service.worker?.durableObjectNamespaces || []).map(value => ({ service: service.name, ...value }))),
    disabledFeatures: ["browser-rendering", "external-model-access", "external-gatekeepers", "authentik-oidc", "artifacts"],
  }, null, 2) + "\n");
  console.log(`Standalone workspace built: ${output}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
