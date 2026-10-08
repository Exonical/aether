import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const upstream = join(root, "cloudflare-os");
const entrypoint = join(upstream, "scripts/run-local.ts");
if (!existsSync(entrypoint)) {
  console.error("Missing cloudflare-os source. Restore it from a complete Aether checkout.");
  process.exit(1);
}
const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
  cwd: upstream,
  stdio: "inherit",
  // Aether validates its newer pnpm against the fork workspace.
  env: { ...process.env, pnpm_config_pm_on_fail: "ignore" },
  // Upstream owns signal forwarding to its server process tree.
  detached: process.platform !== "win32",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
}
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
