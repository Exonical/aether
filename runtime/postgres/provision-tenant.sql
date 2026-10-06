-- Existing dedicated LOGIN role; provision passwords through the operator's secrets workflow.
-- psql -v tenant_id=acme -v role_name=aether_acme -f provision-tenant.sql
\set ON_ERROR_STOP on
BEGIN;
GRANT aether_kv_app TO :"role_name";
INSERT INTO aether.tenant_roles (role_name, tenant_id) VALUES (:'role_name', :'tenant_id');
COMMIT;
