import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { migrate } from "./migrate.js";

// Integration: needs Postgres (BAE6_DATABASE_URL). Unverified until run against one.
const url = process.env.BAE6_DATABASE_URL;
const opts = { skip: url ? false : "BAE6_DATABASE_URL not set" };

// Each test runs in its own schema so it starts from an empty database.
async function withSchema(fn: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await fn(client);
  } finally {
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
    await client.end();
  }
}

const addApp = (client: pg.Client, organization = "acme") =>
  client.query(
    "INSERT INTO applications (organization_id, id, name, environment, store_id) VALUES ($1, 'crm-prod', 'crm', 'prod', $2)",
    [organization, `store-${organization}`],
  );

test("applies to an empty database and re-running is a no-op", opts, () =>
  withSchema(async (client) => {
    const first = await migrate(client);
    assert.ok(first.length > 0);
    assert.deepEqual(await migrate(client), []);
  }),
);

test("rejects updating or deleting audit events", opts, () =>
  withSchema(async (client) => {
    await migrate(client);
    await client.query(
      "INSERT INTO audit_events (organization_id, actor, action, outcome) VALUES ('acme', 'a', 'x', 'success')",
    );
    await assert.rejects(
      client.query("UPDATE audit_events SET actor = 'b'"),
      /append-only/,
    );
    await assert.rejects(
      client.query("DELETE FROM audit_events"),
      /append-only/,
    );
    await assert.rejects(client.query("TRUNCATE audit_events"), /append-only/);
  }),
);

test("allows only one active model binding per application", opts, () =>
  withSchema(async (client) => {
    await migrate(client);
    await addApp(client);
    const bind = (model: string, active: boolean) =>
      client.query(
        "INSERT INTO model_bindings (organization_id, application_id, model_id, active) VALUES ('acme', 'crm-prod', $1, $2)",
        [model, active],
      );
    await bind("m1", true);
    await bind("m0", false);
    await assert.rejects(bind("m2", true), /model_bindings_one_active/);
  }),
);

test(
  "an application ID is unique per organization, and no row can point at another organization's application",
  opts,
  () =>
    withSchema(async (client) => {
      await migrate(client);
      await addApp(client, "acme");
      await addApp(client, "globex");
      await assert.rejects(
        client.query(
          "INSERT INTO applications (organization_id, id, name, environment, store_id) VALUES ('acme', 'crm-prod', 'crm', 'prod', 'store-other')",
        ),
        /applications_pkey/,
      );
      await assert.rejects(addApp(client, "Not-An-Org"), /check constraint/);
      // crm-prod exists in acme and globex, never in initech.
      for (const sql of [
        "INSERT INTO model_bindings (organization_id, application_id, model_id) VALUES ('initech', 'crm-prod', 'm1')",
        "INSERT INTO provider_configs (organization_id, application_id, provider, config) VALUES ('initech', 'crm-prod', 'databricks', '{}')",
        "INSERT INTO workload_bindings (organization_id, application_id, issuer, workload) VALUES ('initech', 'crm-prod', 'i', 'w')",
      ]) {
        await assert.rejects(client.query(sql), /foreign key/, sql);
      }
    }),
);

test(
  "rejects a hyphenated environment that would make ids ambiguous",
  opts,
  () =>
    withSchema(async (client) => {
      await migrate(client);
      await assert.rejects(
        client.query(
          "INSERT INTO applications (organization_id, id, name, environment, store_id) VALUES ('acme', 'a-b-c', 'a', 'b-c', 's1')",
        ),
        /check constraint/,
      );
    }),
);

test("rejects an application id that is not name-environment", opts, () =>
  withSchema(async (client) => {
    await migrate(client);
    await assert.rejects(
      client.query(
        "INSERT INTO applications (organization_id, id, name, environment, store_id) VALUES ('acme', 'other', 'crm', 'prod', 's1')",
      ),
      /check constraint/,
    );
  }),
);
