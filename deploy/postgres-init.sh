#!/bin/sh
# Separate database and role per service so OpenFGA and authz cannot read each other's data.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" \
  -v ofga_pw="$OPENFGA_DB_PASSWORD" -v authz_pw="$BAE6_DB_PASSWORD" <<'SQL'
CREATE ROLE openfga LOGIN PASSWORD :'ofga_pw';
CREATE DATABASE openfga OWNER openfga;
CREATE ROLE authz LOGIN PASSWORD :'authz_pw';
CREATE DATABASE authz OWNER authz;
REVOKE CONNECT ON DATABASE openfga FROM PUBLIC;
REVOKE CONNECT ON DATABASE authz FROM PUBLIC;
SQL
