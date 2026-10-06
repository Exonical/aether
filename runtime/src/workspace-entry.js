export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return request.method === "GET" ? Response.json({ status: "ok" })
        : new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    if (pathname === "/readyz") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      // Read through the selected native KV backend before admitting traffic.
      try { await env.BLUEPRINTS.get(".adminConfig"); }
      catch { return Response.json({ status: "unavailable" }, { status: 503 }); }
      return Response.json({ status: "ready", stage: "standalone-workspace" });
    }
    return env.ROUTER.fetch(request);
  },
};
