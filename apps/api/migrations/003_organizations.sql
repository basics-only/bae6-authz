-- The tenant is the organization (bae6-contracts ADR-0002). Every tenant-owned row carries
-- organization_id; application IDs are unique per organization, so one tenant's names never
-- collide with, or reveal, another's. Rows from before tenancy belong to `default`.

ALTER TABLE model_bindings DROP CONSTRAINT model_bindings_application_id_fkey;
ALTER TABLE provider_configs DROP CONSTRAINT provider_configs_application_id_fkey;
ALTER TABLE workload_bindings DROP CONSTRAINT workload_bindings_application_id_fkey;

ALTER TABLE applications
  ADD COLUMN organization_id text NOT NULL DEFAULT 'default'
    CHECK (organization_id ~ '^[a-z0-9][a-z0-9-]{0,62}$');
ALTER TABLE applications ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE applications DROP CONSTRAINT applications_pkey;
ALTER TABLE applications DROP CONSTRAINT applications_name_environment_key;
ALTER TABLE applications ADD PRIMARY KEY (organization_id, id);

ALTER TABLE model_bindings ADD COLUMN organization_id text NOT NULL DEFAULT 'default';
ALTER TABLE model_bindings ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE model_bindings DROP CONSTRAINT model_bindings_application_id_model_id_key;
ALTER TABLE model_bindings ADD UNIQUE (organization_id, application_id, model_id);
DROP INDEX model_bindings_one_active;
CREATE UNIQUE INDEX model_bindings_one_active
  ON model_bindings (organization_id, application_id) WHERE active;
ALTER TABLE model_bindings ADD FOREIGN KEY (organization_id, application_id)
  REFERENCES applications (organization_id, id);

ALTER TABLE provider_configs ADD COLUMN organization_id text NOT NULL DEFAULT 'default';
ALTER TABLE provider_configs ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE provider_configs DROP CONSTRAINT provider_configs_application_id_provider_key;
ALTER TABLE provider_configs ADD UNIQUE (organization_id, application_id, provider);
ALTER TABLE provider_configs ADD FOREIGN KEY (organization_id, application_id)
  REFERENCES applications (organization_id, id);

ALTER TABLE workload_bindings ADD COLUMN organization_id text NOT NULL DEFAULT 'default';
ALTER TABLE workload_bindings ALTER COLUMN organization_id DROP DEFAULT;
ALTER TABLE workload_bindings DROP CONSTRAINT workload_bindings_pkey;
ALTER TABLE workload_bindings ADD PRIMARY KEY (issuer, workload, organization_id, application_id);
ALTER TABLE workload_bindings ADD FOREIGN KEY (organization_id, application_id)
  REFERENCES applications (organization_id, id);

-- Adding a column fires no row trigger, so the append-only guard is untouched.
ALTER TABLE audit_events ADD COLUMN organization_id text NOT NULL DEFAULT 'default';
ALTER TABLE audit_events ALTER COLUMN organization_id DROP DEFAULT;
-- NOT VALID: enforced for new rows without scanning the existing (backfilled) ones.
ALTER TABLE audit_events ADD CONSTRAINT audit_events_organization_id_check
  CHECK (organization_id ~ '^[a-z0-9][a-z0-9-]{0,62}$') NOT VALID;
DROP INDEX audit_events_application;
CREATE INDEX audit_events_organization ON audit_events (organization_id, id DESC);
CREATE INDEX audit_events_application
  ON audit_events (organization_id, application_id, time DESC);
