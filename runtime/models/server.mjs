import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readConfig } from './config.mjs';

const MAX_BODY = 8 * 1024 * 1024;

/** Private loopback inference proxy. It exposes neither generic HTTP nor model administration. */
export function createAdapter(config) {
  let active = 0;
  const server = createServer(async (req, res) => {
    const reply = (status, message) => { req.resume(); res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify({error:message})); };
    if (req.method === 'GET' && req.url === '/healthz') return reply(200, 'ok');
    if (req.method !== 'POST' || req.url !== '/inference') return reply(404, 'Not found');
    if (req.headers['x-aether-model-tenant'] !== config.tenantId) return reply(403, 'Tenant denied');
    let target;
    try { target = new URL(req.headers['x-aether-model-url']); } catch { return reply(403, 'Destination denied'); }
    const routes = config.protocol === 'openai' ? ['/chat/completions', '/responses'] : ['/messages'];
    if (target.origin !== config.endpoint.origin || target.username || target.password || target.search || target.hash
        || !routes.some(route => target.pathname === config.endpoint.pathname + route)) return reply(403, 'Destination denied');
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(415, 'JSON required');
    if (active >= 4) return reply(429, 'Inference concurrency limit');
    active++;
    let upstream, response;
    const timer = setTimeout(() => { upstream?.destroy(); response?.destroy(); if (!res.headersSent) reply(504, 'Inference timeout'); else res.destroy(); }, 180000);
    const cancel = () => { upstream?.destroy(); response?.destroy(); if (!req.complete) req.destroy(); };
    res.on('close', cancel);
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req.iterator({destroyOnReturn:false})) {
        size += chunk.length;
        if (size > MAX_BODY) { reply(413, 'Request too large'); return; }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, 'Invalid JSON'); }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object' || !config.models.has(payload.model)) return reply(403, 'Model denied');
      // The stateless gateway never exposes stored Responses retrieval/deletion.
      if (target.pathname.endsWith('/responses')) payload.store = false;
      const body = Buffer.from(JSON.stringify(payload));
      const headers = {'content-type':'application/json', 'content-length':String(body.length), 'accept':'application/json, text/event-stream'};
      if (config.protocol === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        if (config.token) headers['x-api-key'] = config.token;
      } else if (config.token) headers.authorization = 'Bearer ' + config.token;
      response = await new Promise((accept, reject) => {
        upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target,
          {method:'POST', headers, ca:config.ca, rejectUnauthorized:true}, accept);
        upstream.on('error', reject); upstream.end(body);
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        return reply(response.statusCode >= 400 && response.statusCode < 600 ? response.statusCode : 502, 'Model provider rejected request');
      }
      // Do not forward cookies, redirects, provider credentials, or hop-by-hop headers.
      res.writeHead(response.statusCode, {'content-type': response.headers['content-type'] || 'application/json', 'cache-control':'no-store'});
      await pipeline(response, res);
    } catch {
      if (!res.headersSent && !res.destroyed) reply(502, 'Model provider unavailable');
      else res.destroy();
    } finally {
      clearTimeout(timer); res.off('close', cancel); cancel(); active--;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return {server, listen:async (port = config.port) => {
    await new Promise((accept, reject) => {server.once('error',reject); server.listen(port,'127.0.0.1',()=>{server.off('error',reject);accept()})});
    return server.address().port;
  }, close:async () => {server.closeAllConnections(); await new Promise(accept=>server.close(accept));}};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const adapter = createAdapter(await readConfig()); await adapter.listen();
    for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>adapter.close().then(()=>process.exit(0)));
  } catch { console.error('Model gateway startup failed: check deployment configuration'); process.exitCode = 1; }
}
