import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { readConfig } from '../config.mjs';

export async function setupDatabase() {
  const adminConfig = {
    host: process.env.AETHER_TEST_PGHOST, port: Number(process.env.AETHER_TEST_PGPORT || '5432'),
    database: 'aether_test', user: 'postgres', password: process.env.AETHER_TEST_PG_ADMIN_PASSWORD || 'aether-test-secret',
    ssl: false,
  };
  const admin = new pg.Pool(adminConfig);
  await admin.query(await readFile(new URL('../migrations/001-kv.sql', import.meta.url), 'utf8'));
  for (const [role, tenant] of [['aether_test_app','test'], ['aether_other_app','other'], ['aether_acme','acme']]) {
    // Fixed synthetic credentials used only in a fresh disposable test database.
    await admin.query('CREATE ROLE ' + role + " LOGIN PASSWORD 'aether-test-secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    await admin.query('GRANT aether_kv_app TO ' + role);
    await admin.query('INSERT INTO aether.tenant_roles VALUES ($1, $2)', [role, tenant]);
  }
  async function config(tenant = 'test', user = 'aether_test_app') {
    return readConfig({ PGHOST: adminConfig.host, PGPORT: String(adminConfig.port), PGDATABASE: adminConfig.database,
      PGUSER: user, PGPASSWORD: 'aether-test-secret', AETHER_TENANT_ID: tenant,
      AETHER_PG_SSL_MODE: 'disable', AETHER_PG_ALLOW_PLAINTEXT: 'true' });
  }
  return { admin, adminConfig, config };
}
