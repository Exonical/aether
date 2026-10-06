import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../config.mjs';

const env = { PGHOST: 'postgres.internal', PGDATABASE: 'aether', PGUSER: 'aether_acme',
  PGPASSWORD: 'test-secret', AETHER_TENANT_ID: 'acme' };
test('PostgreSQL configuration requires explicit tenant credentials and verified TLS', async () => {
  const config = await readConfig(env);
  assert.equal(config.database.ssl.rejectUnauthorized, true);
  assert.equal(config.database.options, '-c search_path=pg_catalog');
  assert.equal(config.database.max, 4);
  assert.equal(config.port, 9002);
  for (const override of [
    { PGHOST: '/tmp/postgres' }, { PGHOST: 'postgres://user:secret@host' },
    { PGPASSWORD: '' }, { AETHER_TENANT_ID: '../other' },
    { AETHER_PG_SSL_MODE: 'require' }, { AETHER_PG_SSL_MODE: 'disable' },
    { PGPORT: '0' }, { AETHER_PG_ADAPTER_PORT: 'invalid' },
  ]) await assert.rejects(readConfig({ ...env, ...override }));
  assert.equal((await readConfig({ ...env, AETHER_PG_SSL_MODE: 'disable', AETHER_PG_ALLOW_PLAINTEXT: 'true' })).database.ssl, false);
  const dir = await mkdtemp(join(tmpdir(), 'aether-pg-ca-'));
  try {
    const ca = join(dir, 'ca.pem'); await writeFile(ca, 'test-ca');
    assert.equal((await readConfig({ ...env, AETHER_PG_CA_FILE: ca })).database.ssl.ca, 'test-ca');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
