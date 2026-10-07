import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KV_PLUGIN, R2_PLUGIN, WorkerOptionsSchema, InstanceOptionsSchema, serializeConfig } from "miniflare";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const supportedKeys = new Set([
  "$schema", "name", "main", "build", "compatibility_date", "compatibility_flags",
  "migrations", "kv_namespaces", "r2_buckets", "worker_loaders", "browser",
  "observability", "services", "assets", "vars", "rules",
]);

/** Validate upstream configuration rather than silently dropping new platform dependencies. */
export function validateWorkerConfig(config) {
  for (const key of Object.keys(config)) {
    if (!supportedKeys.has(key)) throw new Error(`Unsupported ${config.name} configuration: ${key}`);
  }
  if (!config.name || !config.compatibility_date) throw new Error("Worker name and compatibility date are required");
  if (config.browser && config.browser.binding !== "BROWSER") throw new Error("Unsupported browser binding");
  const classes = [];
  for (const migration of config.migrations || []) {
    for (const key of Object.keys(migration)) {
      if (!["tag", "new_sqlite_classes"].includes(key)) {
        throw new Error(`Unsupported migration ${config.name}: ${key}`);
      }
    }
    for (const className of migration.new_sqlite_classes || []) {
      if (classes.includes(className)) throw new Error(`Duplicate DO class ${className}`);
      classes.push(className);
    }
  }
  return classes;
}

/** Compile the pinned storage Workers and upstream graph into a native workerd config. */
export async function createWorkspaceConfig({ workers, assetManifest, namespace, scratch, storage = "local", kvStorage = "local", modelGateway = false }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new Error("Invalid permanent namespace identity");
  if (!["local", "s3"].includes(storage)) throw new Error("Unsupported blob storage mode");
  if (!["local", "postgres"].includes(kvStorage)) throw new Error("Unsupported KV storage mode");
  if (kvStorage === "postgres" && !namespace.startsWith("aether-tenant-")) throw new Error("PostgreSQL KV requires a tenant artifact");
  if (modelGateway && !namespace.startsWith("aether-tenant-")) throw new Error("Model gateway requires a tenant artifact");
  const kvOptions = WorkerOptionsSchema.parse({ config: { name: "aether-kv", compatibilityDate: "2026-09-04",
    env: Object.fromEntries(workers.flatMap(({ config }) => (config.kv_namespaces || []).map(({ binding }) =>
      [binding, { type: "kv", id: `${namespace}-${config.name}-${binding}` }]))) } });
  const r2Options = WorkerOptionsSchema.parse({ config: { name: "aether-r2", compatibilityDate: "2026-09-04",
    env: Object.fromEntries(workers.flatMap(({ config }) => (config.r2_buckets || []).map(({ binding }) =>
      [binding, { type: "r2", name: `${namespace}-${config.name}-${binding}` }]))) } });
  const sharedOptions = InstanceOptionsSchema.parse({ telemetry: { enabled: false } });
  const kvBindings = await KV_PLUGIN.getBindings(kvOptions, sharedOptions);
  const r2Bindings = await R2_PLUGIN.getBindings(r2Options, sharedOptions);
  const storageServices = [
    ...await KV_PLUGIN.getServices({ options: kvOptions, tmpPath: scratch, sharedOptions }),
    ...await R2_PLUGIN.getServices({ options: r2Options, tmpPath: scratch, sharedOptions }),
  ];
  const directories = [{ service: "aether:do-storage", subdirectory: "do" }];
  for (const service of storageServices) {
    if (service.disk) {
      directories.push({ service: service.name, subdirectory: service.name.startsWith("kv") ? "kv" : "r2" });
      delete service.disk.path; // Supplied at launch; build-host paths never enter the artifact.
    }
    if (service.worker) {
      // Miniflare's Node loopback is optional logging/error presentation, not storage.
      // Native workerd logs errors itself; no Node debug/control service is shipped.
      service.worker.bindings = (service.worker.bindings || []).filter(binding => binding.name !== "MINIFLARE_LOOPBACK");
      if (kvStorage === "postgres" && service.name === "kv:ns") {
        const module = service.worker.modules.find(module => module.name === "namespace.worker.js");
        const source = "new KeyValueStorage(this)";
        if (!module?.esModule || module.esModule.split(source).length !== 2) throw new Error("Pinned KV Worker storage contract changed");
        module.esModule = 'import { PostgresKeyValueStorage } from "./postgres-kv-storage.js";\n'
          + module.esModule.replace(source, "new PostgresKeyValueStorage(this)");
        service.worker.modules.push({ name: "postgres-kv-storage.js", esModule: await readFile(join(root, "src/postgres-kv-storage.js"), "utf8") });
        service.worker.bindings.push({ name: "POSTGRES", service: { name: "aether:postgres-endpoint" } });
      }
      if (storage === "s3" && service.name === "r2:bucket") {
        const blobs = service.worker.bindings.find(binding => binding.name === "MINIFLARE_BLOBS");
        if (!blobs?.service) throw new Error("Pinned R2 worker no longer exposes BlobStore");
        blobs.service = { name: "aether:s3-blobs" };
      }
    }
  }
  const services = workers.map(({ config, modules }) => {
    const classes = validateWorkerConfig(config);
    const bindings = [
      ...(config.kv_namespaces || []).map(({ binding }) => kvBindings.find(value => value.name === binding)),
      ...(config.r2_buckets || []).map(({ binding }) => r2Bindings.find(value => value.name === binding)),
      ...(config.worker_loaders || []).map(({ binding }) => ({ name: binding, workerLoader: {} })),
      ...Object.entries(config.vars || {}).map(([name, value]) => typeof value === "string"
        ? { name, text: value } : { name, json: JSON.stringify(value) }),
      ...(config.services || []).map(({ binding, service, entrypoint, props }) => ({
        name: binding, service: { name: service, entrypoint, ...(props ? { props: { json: JSON.stringify(props) } } : {}) },
      })),
    ];
    if (config.name === "router") bindings.push({ name: "ASSETS", service: { name: "aether:assets" } });
    if (config.name === "workshop-backend") {
      bindings.push(
        { name: "ADMINS", fromEnvironment: "AETHER_ADMINS" },
        { name: "GATEKEEPER_CONTEXT", service: { name: "gatekeeper-context", entrypoint: "GatekeeperVendor", props: { json: JSON.stringify({ sharingDomain: namespace }) } } },
        { name: "GATEKEEPER_SCHEDULER", service: { name: "gatekeeper-scheduler", entrypoint: "GatekeeperVendor" } },
      );
    }
    if (config.name === "router") {
      bindings.push(
        { name: "GATEKEEPER_CONTEXT", service: { name: "gatekeeper-context" } },
        { name: "GATEKEEPER_SCHEDULER", service: { name: "gatekeeper-scheduler" } },
      );
    }
    const names = bindings.map(binding => binding?.name);
    if (names.includes(undefined) || new Set(names).size !== names.length) throw new Error(`Invalid or duplicate binding in ${config.name}`);
    return { name: config.name, worker: {
      modules, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags || [],
      bindings,
      ...(modelGateway && config.name === "workshop-backend" ? { globalOutbound: { name: "aether:model-outbound" } } : {}),
      ...(classes.length ? {
        durableObjectNamespaces: classes.map(className => ({ className, uniqueKey: `${namespace}-${config.name}-${className}`, enableSql: true })),
        durableObjectStorage: { localDisk: "aether:do-storage" },
      } : {}),
    } };
  });
  services.push(
    ...storageServices,
    { name: "aether:do-storage", disk: { writable: true } },
    { name: "aether:assets-disk", disk: { writable: false } },
    { name: "aether:assets", worker: {
      compatibilityDate: "2026-09-04",
      modules: [{ name: "assets.js", esModule: await readFile(join(root, "src/assets.js"), "utf8") }],
      bindings: [{ name: "FILES", service: { name: "aether:assets-disk" } }, { name: "MANIFEST", json: JSON.stringify(assetManifest) }],
    } },
    { name: "aether:entry", worker: {
      compatibilityDate: "2026-09-04",
      modules: [{ name: "entry.js", esModule: await readFile(join(root, "src/workspace-entry.js"), "utf8") }],
      bindings: [{ name: "ROUTER", service: { name: "router" } }, kvBindings.find(binding => binding.name === "BLUEPRINTS")],
    } },
    { name: "internet", network: { allow: [] } },
  );
  if (storage === "s3") services.push(
    { name: "aether:s3-endpoint", external: { address: "127.0.0.1:9001", http: {} } },
    { name: "aether:s3-blobs", worker: {
      compatibilityDate: "2026-09-04",
      modules: [{ name: "s3-blobs.js", esModule: await readFile(join(root, "src/s3-blobs.js"), "utf8") }],
      bindings: [{ name: "ADAPTER", service: { name: "aether:s3-endpoint" } }],
    } },
  );
  if (kvStorage === "postgres") services.push({ name: "aether:postgres-endpoint", external: { address: "127.0.0.1:9002", http: {} } });
  if (modelGateway) services.push(
    { name: "aether:model-endpoint", external: { address: "127.0.0.1:9003", http: {} } },
    { name: "aether:model-outbound", worker: {
      compatibilityDate: "2026-09-04",
      modules: [{ name: "model-outbound.js", esModule: await readFile(join(root, "src/model-outbound.js"), "utf8") }],
      bindings: [{ name: "ADAPTER", service: { name: "aether:model-endpoint" } },
        { name: "TENANT", text: namespace.slice("aether-tenant-".length) }],
    } },
  );
  const sharedRoot = join(dirname(require.resolve("miniflare")), "workers/shared");
  const config = {
    services,
    sockets: [{ name: "http", http: {}, service: { name: "aether:entry" } }],
    extensions: [{ modules: [
      { name: "miniflare:shared", esModule: await readFile(join(sharedRoot, "index.worker.js"), "utf8") },
      { name: "miniflare:zod", esModule: await readFile(join(sharedRoot, "zod.worker.js"), "utf8") },
    ] }],
  };
  return { config, binary: serializeConfig(config), directories };
}
