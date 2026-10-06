import { readFile } from 'node:fs/promises';

/** One deployment-owned endpoint and model allowlist, never selected by request headers. */
export async function readConfig(env = process.env) {
  const tenantId = env.AETHER_TENANT_ID;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantId || '')) throw new Error('Invalid AETHER_TENANT_ID');
  const endpoint = new URL(env.AETHER_MODEL_ENDPOINT);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || /%|\/\//.test(endpoint.pathname)) throw new Error('Invalid AETHER_MODEL_ENDPOINT');
  if (endpoint.protocol === 'http:' && env.AETHER_MODEL_ALLOW_HTTP !== 'true') throw new Error('HTTP requires AETHER_MODEL_ALLOW_HTTP=true');
  const protocol = env.AETHER_MODEL_PROTOCOL || 'openai';
  if (!['openai', 'anthropic'].includes(protocol)) throw new Error('Invalid AETHER_MODEL_PROTOCOL');
  const models = JSON.parse(env.AETHER_MODEL_ALLOWLIST || '[]');
  if (!Array.isArray(models) || !models.length || models.length > 100 || models.some(model => typeof model !== 'string' || !model || model.length > 256)) throw new Error('Invalid AETHER_MODEL_ALLOWLIST');
  const token = env.AETHER_MODEL_TOKEN || '';
  if (/[^\x21-\x7e]/.test(token)) throw new Error('Invalid AETHER_MODEL_TOKEN');
  const port = Number(env.AETHER_MODEL_PORT || 9003);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid AETHER_MODEL_PORT');
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '');
  return {tenantId, endpoint, protocol, models: new Set(models), token, port,
    ca: env.AETHER_MODEL_CA_FILE ? await readFile(env.AETHER_MODEL_CA_FILE) : undefined};
}
