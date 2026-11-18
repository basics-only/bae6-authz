import assert from "node:assert/strict";
import { test } from "node:test";
import { Databricks, DatabricksDeniedError } from "../src/databricks.js";

// UNVERIFIED: runs only against an authorized workspace and has not been run. It needs
// BAE6_DATABRICKS_HOST, BAE6_DATABRICKS_WAREHOUSE_ID, BAE6_DATABRICKS_USER_TOKEN (a user's own
// token) and BAE6_DATABRICKS_DENIED_TABLE (a table that user has no grant on).
const env = process.env;
const configured =
  env.BAE6_DATABRICKS_HOST &&
  env.BAE6_DATABRICKS_WAREHOUSE_ID &&
  env.BAE6_DATABRICKS_USER_TOKEN &&
  env.BAE6_DATABRICKS_DENIED_TABLE;

test(
  "unverified: real unity catalog denies a user without a grant",
  {
    skip: configured
      ? false
      : "UNVERIFIED: needs an authorized workspace, a user token, and a table that user cannot read",
  },
  async () => {
    const db = new Databricks({
      workspaceHost: env.BAE6_DATABRICKS_HOST as string,
      warehouseId: env.BAE6_DATABRICKS_WAREHOUSE_ID as string,
    });
    const userToken = env.BAE6_DATABRICKS_USER_TOKEN as string;

    assert.deepEqual((await db.query("SELECT 1", { userToken })).rows, [["1"]]);
    await assert.rejects(
      db.query(`SELECT * FROM ${env.BAE6_DATABRICKS_DENIED_TABLE} LIMIT 1`, {
        userToken,
      }),
      DatabricksDeniedError,
    );
  },
);
