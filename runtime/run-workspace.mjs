import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.env.AETHER_BUILD_DIR || join(root, "dist/workspace"));
const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1) throw new Error("Unsupported workspace artifact schema");
const state = resolve(process.env.AETHER_STATE_DIR || join(root, ".workspace-state"));
const port = process.env.AETHER_PORT || "8080";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid AETHER_PORT");
const args = ["serve", join(output, "workspace.capnp.bin"), "--binary", "--experimental", `--socket-addr=http=127.0.0.1:${port}`,
  `--directory-path=aether:assets-disk=${join(output, "assets")}`];
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
