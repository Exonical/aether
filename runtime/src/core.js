import { DurableObject } from "cloudflare:workers";

// A real SQLite-backed DO used only to verify the standalone runtime's storage lifecycle.
export class RuntimeState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO probe (id, value) VALUES (1, 0)");
  }

  async fetch(request) {
    if (!["GET", "POST"].includes(request.method)) {
      return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
    }
    if (request.method === "POST") {
      this.ctx.storage.sql.exec("UPDATE probe SET value = value + 1 WHERE id = 1");
    }
    const { value } = this.ctx.storage.sql.exec("SELECT value FROM probe WHERE id = 1").one();
    return Response.json({ value });
  }
}

const probeCode = `
  export default {
    async fetch() {
      try {
        await fetch("https://example.com/");
        return Response.json({ loaded: true, ambientNetworkDenied: false }, { status: 500 });
      } catch {
        return Response.json({ loaded: true, ambientNetworkDenied: true });
      }
    }
  };
`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/readyz" || pathname === "/internal/probes/state") {
      const allowed = pathname === "/readyz" ? ["GET"] : ["GET", "POST"];
      if (!allowed.includes(request.method)) {
        return new Response(null, { status: 405, headers: { Allow: allowed.join(", ") } });
      }
      const state = env.STATE.get(env.STATE.idFromName("runtime-probe"));
      return state.fetch(request);
    }
    if (pathname === "/internal/probes/worker") {
      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "POST" } });
      }
      // Only this fixed diagnostic module is loadable. No user-supplied code endpoint.
      const worker = env.LOADER.get("aether-network-probe-v1", async () => ({
        compatibilityDate: "2026-09-04",
        mainModule: "probe.js",
        modules: { "probe.js": probeCode },
        globalOutbound: null,
        env: {},
      }));
      return worker.getEntrypoint().fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
