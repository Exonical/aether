import { readFile } from "node:fs/promises";

/** Explicit connection settings prevent URL parameters overriding TLS verification. */
export async function readConfig(env = process.env) {
  for (const name of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD", "AETHER_TENANT_ID"]) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.AETHER_TENANT_ID)) throw new Error("Invalid AETHER_TENANT_ID");
  if (!/^[a-zA-Z0-9.:-]+$/.test(env.PGHOST)) throw new Error("PGHOST must be a hostname or IP address");
  const sslMode = env.AETHER_PG_SSL_MODE || "verify-full";
  if (!["verify-full", "disable"].includes(sslMode)) throw new Error("AETHER_PG_SSL_MODE must be verify-full or disable");
  if (sslMode === "disable" && env.AETHER_PG_ALLOW_PLAINTEXT !== "true") throw new Error("Plaintext PostgreSQL requires AETHER_PG_ALLOW_PLAINTEXT=true");
  function port(name, fallback) {
    const value = env[name] || fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid ${name}`);
    return Number(value);
  }
  const ca = env.AETHER_PG_CA_FILE ? await readFile(env.AETHER_PG_CA_FILE, "utf8") : undefined;
  return {
    tenantId: env.AETHER_TENANT_ID, port: port("AETHER_PG_ADAPTER_PORT", "9002"),
    database: {
      host: env.PGHOST, port: port("PGPORT", "5432"), database: env.PGDATABASE, user: env.PGUSER, password: env.PGPASSWORD,
      ssl: sslMode === "disable" ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
      options: "-c search_path=pg_catalog", application_name: "aether-kv", client_encoding: "UTF8",
      max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
      statement_timeout: 5000, query_timeout: 10000, lock_timeout: 3000,
    },
  };
}
