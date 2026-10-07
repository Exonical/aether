export function browserCookie(request, publicUrl) {
  const name = new URL(publicUrl).protocol === 'https:' ? '__Host-aether-login' : 'aether-login-dev';
  const values = (request.headers.get('cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

// Called only by the trusted backend's PublicApi constructor, never by Gadget code.
export async function bindOidcBrowser(env, request) {
  const browser = browserCookie(request, env.OIDC_PUBLIC_URL);
  if (!browser) throw new Error('Open the sign-in page before using the API');
  return {...env, GATEKEEPER_OIDC:await env.GATEKEEPER_OIDC.forBrowser(browser)};
}

export function randomNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function oidcSessionExpired(session, env) {
  const ttl = Number(env.AETHER_OIDC_SESSION_TTL);
  return !session || !Number.isInteger(ttl) || ttl < 60 || ttl > 86400
    || !(session.created instanceof Date) || !Number.isFinite(session.created.getTime())
    || Date.now() - session.created.getTime() >= ttl * 1000;
}
