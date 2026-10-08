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
      if (url.host !== publicUrl.host && pathname !== '/gatekeeper/oidc/backchannel-logout') return new Response('Invalid host', {status:400});
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!browserCookie(request, publicUrl.href) || request.headers.get('origin') !== publicUrl.origin
            || request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Same-origin browser required', {status:403});
      }
      let response = await (pathname === '/departments' || pathname === '/api/departments'
        ? env.DEPARTMENTS : env.ROUTER).fetch(request);
      if(pathname === '/' && request.method === 'GET' && env.DEPARTMENTS_ENABLED === 'true'
          && response.headers.get('content-type')?.startsWith('text/html')) {
        const html=await response.text();const headers=new Headers(response.headers);
        headers.delete('content-length');headers.delete('etag');headers.set('cache-control','no-store');
        response=new Response(html.replace('</body>', '<a href="/departments" style="position:fixed;bottom:16px;right:16px;z-index:1000;background:#fff;color:#24519a;border:1px solid #ccc;border-radius:8px;padding:8px 12px;font:14px system-ui">Departments</a></body>'),{status:response.status,headers});
      }
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
    if(pathname === '/departments' || pathname === '/api/departments') return env.DEPARTMENTS.fetch(request);
    return env.ROUTER.fetch(request);
  },
};
