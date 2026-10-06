export default {
  async fetch(request, env) {
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const pathname = new URL(request.url).pathname;
    let path = pathname;
    if (!Object.hasOwn(env.MANIFEST, path)) {
      // SPA navigation falls back to index; missing asset files must stay 404s.
      if (path.startsWith("/assets/") || /\.[^/]+$/.test(path)) {
        return new Response("Not found", { status: 404 });
      }
      path = "/index.html";
    }
    const asset = env.MANIFEST[path];
    if (!asset) return new Response("Not found", { status: 404 });
    const headers = {
      "Content-Type": asset.contentType,
      "ETag": `"${asset.sha256}"`,
      "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.headers.get("If-None-Match") === headers.ETag) {
      return new Response(null, { status: 304, headers });
    }
    // Only exact paths in the generated manifest can reach the read-only disk service.
    const response = await env.FILES.fetch(new Request(new URL(path, "http://assets.local"), {
      method: request.method,
    }));
    if (!response.ok) return new Response("Asset unavailable", { status: 503 });
    headers["Content-Length"] = String(asset.size);
    return new Response(request.method === "HEAD" ? null : response.body, { headers });
  },
};
