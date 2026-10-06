import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { readConfig } from "./config.mjs";

const now = "floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint";
class RequestError extends Error { constructor(status) { super("Invalid KV request"); this.status = status; } }
function decode(value, limit) {
  if (typeof value !== "string" || value.length > Math.ceil(limit * 4 / 3) + 4 || !/^[A-Za-z0-9_-]*$/.test(value)) throw new RequestError(400);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > limit || bytes.toString("base64url") !== value) throw new RequestError(400);
  return bytes;
}
function key(value) {
  const bytes = decode(value, 512);
  if (!bytes.length || [".", ".."].includes(bytes.toString())) throw new RequestError(400);
  return bytes;
}
function entry(row) {
  return { key: row.key.toString("utf8"),
    ...(row.expiration === null ? {} : { expiration: Number(row.expiration) }),
    ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
  };
}

/** Refuse owner/admin roles and require a matching immutable login-to-tenant mapping. */
export async function verifyDatabase(pool, tenantId) {
  const roles = await pool.query(`WITH RECURSIVE memberships(oid) AS (
    SELECT oid FROM pg_roles WHERE rolname = session_user
    UNION SELECT m.roleid FROM pg_auth_members m JOIN memberships p ON m.member = p.oid
  ) SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication
    FROM pg_roles r JOIN memberships p USING (oid)`);
  if (!roles.rowCount || roles.rows.some(role => Object.values(role).some(Boolean))) throw new Error("Runtime database role must not have administrative privileges");
  const tables = await pool.query(`SELECT c.relrowsecurity, c.relforcerowsecurity,
    pg_has_role(session_user, c.relowner, 'MEMBER') AS owns_table,
    pg_has_role(session_user, n.nspowner, 'MEMBER') AS owns_schema
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'aether' AND c.relname IN ('kv_entries', 'tenant_roles')`);
  if (tables.rowCount !== 2 || tables.rows.some(table => !table.relrowsecurity || !table.relforcerowsecurity || table.owns_table || table.owns_schema)) {
    throw new Error("Runtime database role requires protected non-owned tables");
  }
  const database = await pool.query("SELECT pg_has_role(session_user, datdba, 'MEMBER') AS owns_database FROM pg_database WHERE datname = current_database()");
  if (database.rows[0]?.owns_database !== false) throw new Error("Runtime database role must not own the database");
  const schema = await pool.query("SELECT version FROM aether.schema_version");
  if (schema.rowCount !== 1 || schema.rows[0].version !== 1) throw new Error("Unsupported PostgreSQL KV schema");
  const mapping = await pool.query("SELECT tenant_id FROM aether.tenant_roles WHERE role_name = session_user");
  if (mapping.rowCount !== 1 || mapping.rows[0].tenant_id !== tenantId) throw new Error("Database login tenant identity mismatch");
}

/** Loopback-only backend for trusted native KV protocol Workers. */
export async function createAdapter(config) {
  const pool = new pg.Pool(config.database);
  pool.on("error", () => console.error(JSON.stringify({ event: "postgres.connection.failed" })));
  try { await verifyDatabase(pool, config.tenantId); } catch (error) { await pool.end(); throw error; }
  let active = 0;
  const waiting = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/healthz" && request.method === "GET") { response.writeHead(200).end("ok"); return; }
    if (active >= 4) {
      if (waiting.length >= 32) { request.resume(); response.writeHead(503).end("KV adapter busy"); return; }
      // Leave bodies paused until a slot is available, rather than buffering queued uploads.
      await new Promise(resolve => waiting.push(resolve));
    } else active++;
    try {
      if (request.url === "/readyz" && request.method === "GET") {
        const mapping = await pool.query("SELECT tenant_id FROM aether.tenant_roles WHERE role_name = session_user");
        if (mapping.rows[0]?.tenant_id !== config.tenantId) throw new Error("Database mapping changed");
        response.writeHead(200).end("ready"); return;
      }
      const namespace = request.headers["x-aether-namespace"];
      if (typeof namespace !== "string" || !namespace.startsWith(`aether-tenant-${config.tenantId}-`) || namespace.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(namespace)) throw new RequestError(403);
      const url = new URL(request.url, "http://postgres");
      const scope = [config.tenantId, namespace];
      if (url.pathname === "/entry") {
        scope.push(key(url.searchParams.get("key")));
        if (request.method === "GET") {
          const result = await pool.query(`SELECT key, value, metadata, expiration FROM aether.kv_entries
            WHERE tenant_id = $1 AND namespace = $2 AND key = $3 AND (expiration IS NULL OR expiration > ${now})`, scope);
          const row = result.rows[0];
          if (!row) { response.writeHead(404).end(); return; }
          const headers = { "Content-Type": "application/octet-stream", "Content-Length": String(row.value.length) };
          if (row.expiration !== null) headers["X-Aether-Expiration"] = row.expiration;
          if (row.metadata !== null) headers["X-Aether-Metadata"] = Buffer.from(row.metadata).toString("base64url");
          response.writeHead(200, headers).end(row.value);
        } else if (request.method === "PUT") {
          let expiration = null, metadata = null;
          if (request.headers["x-aether-expiration"] !== undefined) {
            expiration = Number(request.headers["x-aether-expiration"]);
            if (!Number.isSafeInteger(expiration) || expiration <= 0) throw new RequestError(400);
          }
          if (request.headers["x-aether-metadata"] !== undefined) {
            metadata = decode(request.headers["x-aether-metadata"], 1024).toString("utf8");
            try { JSON.parse(metadata); } catch { throw new RequestError(400); }
          }
          const chunks = []; let size = 0;
          for await (const chunk of request.iterator({ destroyOnReturn: false })) {
            size += chunk.length;
            if (size > 25 * 1024 * 1024) throw new RequestError(413);
            chunks.push(chunk);
          }
          await pool.query(`INSERT INTO aether.kv_entries (tenant_id, namespace, key, value, expiration, metadata)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, namespace, key)
            DO UPDATE SET value = EXCLUDED.value, expiration = EXCLUDED.expiration, metadata = EXCLUDED.metadata`,
          [...scope, Buffer.concat(chunks, size), expiration, metadata]);
          response.writeHead(204).end();
        } else if (request.method === "DELETE") {
          await pool.query("DELETE FROM aether.kv_entries WHERE tenant_id = $1 AND namespace = $2 AND key = $3", scope);
          response.writeHead(204).end();
        } else throw new RequestError(405);
      } else if (url.pathname === "/list" && request.method === "GET") {
        const prefix = url.searchParams.get("prefix") || "", prefixBytes = Buffer.from(prefix);
        const limit = Number(url.searchParams.get("limit") || "1000");
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || prefixBytes.length > 512) throw new RequestError(400);
        let after = Buffer.alloc(0);
        const cursor = url.searchParams.get("cursor");
        if (cursor !== null) {
          let parsed;
          try { parsed = JSON.parse(decode(cursor, 2048).toString("utf8")); } catch { throw new RequestError(400); }
          if (parsed.v !== 1 || parsed.namespace !== namespace || parsed.prefix !== prefix) throw new RequestError(400);
          after = key(parsed.key);
        }
        const result = await pool.query(`SELECT key, expiration, metadata FROM aether.kv_entries
          WHERE tenant_id = $1 AND namespace = $2 AND substring(key FROM 1 FOR octet_length($3::bytea)) = $3
          AND key > $4 AND (expiration IS NULL OR expiration > ${now}) ORDER BY key LIMIT $5`,
        [...scope, prefixBytes, after, limit + 1]);
        const more = result.rows.length > limit, rows = result.rows.slice(0, limit);
        const next = more ? Buffer.from(JSON.stringify({ v: 1, namespace, prefix, key: rows.at(-1).key.toString("base64url") })).toString("base64url") : undefined;
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: rows.map(entry), ...(next ? { cursor: next } : {}) }));
      } else throw new RequestError(404);
    } catch (error) {
      request.resume();
      if (!response.headersSent) response.writeHead(error.status || 503).end("PostgreSQL KV request failed");
      else response.destroy();
      if (!(error instanceof RequestError)) console.error(JSON.stringify({ event: "postgres.request.failed", code: /^[0-9A-Z]{5}$/.test(error.code) ? error.code : "unknown" }));
    } finally {
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  });
  const cleanup = setInterval(() => {
    void pool.query(`DELETE FROM aether.kv_entries WHERE ctid IN (
      SELECT ctid FROM aether.kv_entries WHERE tenant_id = $1 AND expiration <= ${now} LIMIT 1000
    )`, [config.tenantId]).catch(() => console.error(JSON.stringify({ event: "postgres.expiration.cleanup.failed" })));
  }, 60000);
  cleanup.unref();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on("close", () => { clearInterval(cleanup); void pool.end(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = await readConfig();
    const server = await createAdapter(config);
    server.listen(config.port, "127.0.0.1", () => console.log("Aether PostgreSQL KV adapter listening on loopback"));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
      server.close();
      const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 25000);
      timeout.unref();
    });
  } catch { console.error("PostgreSQL KV adapter initialization failed"); process.exitCode = 1; }
}
