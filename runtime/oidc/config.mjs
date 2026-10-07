import { readFile } from 'node:fs/promises';

export async function readConfig(env = process.env) {
  const tenantId = env.AETHER_TENANT_ID;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantId || '')) throw new Error('Invalid AETHER_TENANT_ID');
  const allowHttp = env.AETHER_OIDC_ALLOW_HTTP === 'true';
  const parseUrl = (value, name) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || /%|\/\//.test(url.pathname) || (url.protocol === 'http:' && !allowHttp)) throw new Error(`Invalid ${name}`);
    return url;
  };
  const issuer = parseUrl(env.AETHER_OIDC_ISSUER, 'AETHER_OIDC_ISSUER');
  const publicUrl = parseUrl(env.AETHER_PUBLIC_URL, 'AETHER_PUBLIC_URL');
  if (publicUrl.pathname !== '/') throw new Error('AETHER_PUBLIC_URL must be an origin');
  const clientId = env.AETHER_OIDC_CLIENT_ID;
  const clientSecret = env.AETHER_OIDC_CLIENT_SECRET;
  if (!clientId || !clientSecret || clientId.length > 256 || clientSecret.length > 4096) throw new Error('OIDC client ID and secret required');
  const authMethod = env.AETHER_OIDC_CLIENT_AUTH || 'client_secret_basic';
  if (!['client_secret_basic', 'client_secret_post'].includes(authMethod)) throw new Error('Invalid AETHER_OIDC_CLIENT_AUTH');
  const signingAlgorithm = env.AETHER_OIDC_SIGNING_ALG || 'RS256';
  if (!['RS256', 'PS256', 'ES256', 'EdDSA'].includes(signingAlgorithm)) throw new Error('Invalid AETHER_OIDC_SIGNING_ALG');
  const port = Number(env.AETHER_OIDC_PORT || 9004);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AETHER_OIDC_PORT');
  const requiredClaim = env.AETHER_OIDC_REQUIRED_CLAIM;
  const requiredValue = env.AETHER_OIDC_REQUIRED_VALUE;
  if (!!requiredClaim !== !!requiredValue || (requiredClaim && !/^[a-zA-Z0-9_-]{1,64}$/.test(requiredClaim))) throw new Error('OIDC claim and value must be configured together');
  return {tenantId, issuer, issuerIdentifier:env.AETHER_OIDC_ISSUER, publicUrl, redirectUri: new URL('/gatekeeper/oidc/oauth', publicUrl).href,
    clientId, clientSecret, authMethod, signingAlgorithm, port, allowHttp, requiredClaim, requiredValue,
    ca: env.AETHER_OIDC_CA_FILE ? await readFile(env.AETHER_OIDC_CA_FILE) : undefined};
}
