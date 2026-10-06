export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return request.method === "GET" ? Response.json({ status: "ok" })
        : new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    if (pathname === "/readyz") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
      // Read via the real storage protocol; DO instantiation verifies the local SQLite disk.
      await env.BLUEPRINTS.get(".adminConfig");
      return Response.json({ status: "ready", stage: "standalone-workspace" });
    }
    return env.ROUTER.fetch(request);
  },
};
