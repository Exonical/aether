import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(fileURLToPath(import.meta.url));
const state = resolve(process.env.AETHER_STATE_DIR || join(root, ".state"));
const port = process.env.AETHER_PORT || "8080";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("AETHER_PORT must be an integer between 1 and 65535");
}
mkdirSync(state, { recursive: true });
// workerd resolves the native executable for this OS (including Windows' .exe).
const workerd = createRequire(import.meta.url)("workerd").default;
const child = spawn(workerd, [
  "serve", join(root, "aether.capnp"),
  "--experimental",
  `--socket-addr=http=127.0.0.1:${port}`,
  `--directory-path=state=${state}`,
], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
