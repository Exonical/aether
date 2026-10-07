import { browserCookie, randomNonce } from './oidc-browser.js';
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
    if (env.OIDC_PUBLIC_URL) {
      const publicUrl = new URL(env.OIDC_PUBLIC_URL);
      const url = new URL(request.url);
      if (url.host !== publicUrl.host) return new Response('Invalid host', {status:400});
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!browserCookie(request, publicUrl.href) || request.headers.get('origin') !== publicUrl.origin
            || request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Same-origin browser required', {status:403});
      }
      const response = await env.ROUTER.fetch(request);
      if (request.method === 'GET' && !pathname.startsWith('/gatekeeper/') && response.headers.get('content-type')?.startsWith('text/html')
          && !browserCookie(request, publicUrl.href)) {
        const headers = new Headers(response.headers);
        const secure = publicUrl.protocol === 'https:';
        headers.append('set-cookie', `${secure ? '__Host-aether-login' : 'aether-login-dev'}=${randomNonce()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure ? '; Secure' : ''}`);
        headers.set('cache-control', 'no-store');
        return new Response(response.body, {status:response.status, headers});
      }
      return response;
    }
    return env.ROUTER.fetch(request);
  },
};
