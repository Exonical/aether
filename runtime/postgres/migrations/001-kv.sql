-- Run once as a schema administrator, never with runtime credentials.
BEGIN;
CREATE SCHEMA aether;
REVOKE ALL ON SCHEMA aether FROM PUBLIC;
CREATE ROLE aether_kv_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE TABLE aether.schema_version (version integer PRIMARY KEY CHECK (version = 1));
INSERT INTO aether.schema_version VALUES (1);
CREATE TABLE aether.tenant_roles (
  role_name name PRIMARY KEY,
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);
CREATE TABLE aether.kv_entries (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  namespace text NOT NULL CHECK (starts_with(namespace, 'aether-tenant-' || tenant_id || '-')),
  key bytea NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 512),
  value bytea NOT NULL CHECK (octet_length(value) <= 26214400),
  expiration bigint CHECK (expiration IS NULL OR expiration > 0),
  metadata text CHECK (metadata IS NULL OR octet_length(metadata) <= 1024),
  PRIMARY KEY (tenant_id, namespace, key)
);
CREATE INDEX kv_expiration ON aether.kv_entries (tenant_id, expiration) WHERE expiration IS NOT NULL;

ALTER TABLE aether.tenant_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE aether.tenant_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY own_role ON aether.tenant_roles FOR SELECT
  USING (role_name = session_user);
ALTER TABLE aether.kv_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aether.kv_entries FORCE ROW LEVEL SECURITY;
-- session_user is the authenticated login, not a caller-supplied tenant setting.
CREATE POLICY own_tenant ON aether.kv_entries
  USING (tenant_id = (SELECT tenant_id FROM aether.tenant_roles WHERE role_name = session_user))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM aether.tenant_roles WHERE role_name = session_user));

GRANT USAGE ON SCHEMA aether TO aether_kv_app;
GRANT SELECT ON aether.schema_version, aether.tenant_roles TO aether_kv_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON aether.kv_entries TO aether_kv_app;
COMMIT;
