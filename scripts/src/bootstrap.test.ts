import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { bootstrapAdmin, workloadSubject } from "./bootstrap.js";

test("names a workload as the API does, by the hash of issuer and client ID", () => {
  // The same vector is pinned in apps/api/src/admin/elevate.test.ts; change both together.
  assert.equal(
    workloadSubject("https://idp.example.test", "ops"),
    "159a4a0e1c6bdd49744b2d63187091850cc5e70d1e6cb0618d0c93e2a85906f2",
  );
});

test("refuses an admin subject that could name another OpenFGA user", async () => {
  // Rejected before any request, so the unreachable URL is never contacted.
  for (const admin of ["", "a#b", "user:x", "a b", "a|b"]) {
    await assert.rejects(
      bootstrapAdmin("unused.fga", {
        apiUrl: "http://127.0.0.1:1",
        admin,
        organization: "acme",
      }),
      /plain subject/,
    );
  }
});

test("refuses an organization that could name another OpenFGA object", async () => {
  for (const organization of ["", "Acme", "acme#member", "organization:acme"]) {
    await assert.rejects(
      bootstrapAdmin("unused.fga", {
        apiUrl: "http://127.0.0.1:1",
        admin: "olga",
        organization,
      }),
      /organization must be/,
    );
  }
});

// Integration: needs a running OpenFGA with no bae6-admin store. Unverified until run against one.
test(
  "bootstraps once and refuses a second run, even past the first page of stores",
  { skip: process.env.OPENFGA_API_URL ? false : "OPENFGA_API_URL not set" },
  async () => {
    const apiUrl = process.env.OPENFGA_API_URL as string;
    const model = resolve(
      import.meta.dirname,
      "../../models/openfga/bae6-admin.fga",
    );
    const client = new OpenFgaClient({ apiUrl });
    // Push the admin store beyond the first page so a one-page lookup would miss it.
    const filler: string[] = [];
    let storeId: string | undefined;
    try {
      for (let i = 0; i < 101; i++) {
        filler.push((await client.createStore({ name: "filler" })).id);
      }
      const target = { apiUrl, admin: "olga", organization: "acme" };
      ({ storeId } = await bootstrapAdmin(model, target));
      await assert.rejects(bootstrapAdmin(model, target), /already exists/);
    } finally {
      for (const id of [...filler, ...(storeId ? [storeId] : [])]) {
        await new OpenFgaClient({ apiUrl, storeId: id }).deleteStore();
      }
    }
  },
);
