export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return request.method === "GET"
        ? Response.json({ status: "ok" })
        : new Response(null, { status: 405, headers: { Allow: "GET" } });
    }
    if (pathname === "/" || pathname === "/api/runtime") {
      if (request.method !== "GET") {
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      }
      return Response.json({
        name: "Aether",
        stage: "runtime-foundation",
        cloudflareOSIntegrated: false,
        runtime: "workerd",
        storage: "local-sqlite",
        replicas: 1,
      });
    }
    if (["/readyz", "/internal/probes/state", "/internal/probes/worker"].includes(pathname)) {
      return env.CORE.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
};
