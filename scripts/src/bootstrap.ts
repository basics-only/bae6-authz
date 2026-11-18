import { createHash } from "node:crypto";
import { OpenFgaClient } from "@openfga/sdk";
import { writeModel } from "./model.js";

export const ADMIN_STORE_NAME = "bae6-admin";

/**
 * A workload's name in the admin store: the API keys it by the SHA-256 of the JSON pair
 * `[issuer, workload]` (apps/api/src/admin/elevate.ts), since the raw pair cannot be an
 * OpenFGA user ID.
 */
export const workloadSubject = (issuer: string, workload: string) =>
  createHash("sha256")
    .update(JSON.stringify([issuer, workload]))
    .digest("hex");

// Same shape the API accepts for a subject, since it is spliced into `user:<sub>`.
const SUBJECT = /^[A-Za-z0-9._@+-]{1,128}$/;
// Same as the API's organization ID: an issuer's configured `organization`.
const ORGANIZATION = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Creates authz's own admin store, writes the admin model and makes `admin` the
 * first security admin of `organization`. Both are supplied by the operator; nothing is
 * hardcoded. Refuses to run twice, so it cannot silently create a second store.
 */
export async function bootstrapAdmin(
  modelFile: string,
  target: { apiUrl: string; admin: string; organization: string },
): Promise<{ storeId: string; modelId: string }> {
  if (!SUBJECT.test(target.admin)) {
    throw new Error("admin must be a plain subject (letters, digits, ._@+-)");
  }
  if (!ORGANIZATION.test(target.organization)) {
    throw new Error(
      "organization must be lowercase letters, digits and hyphens (at most 63)",
    );
  }
  const lister = new OpenFgaClient({ apiUrl: target.apiUrl });
  let continuationToken: string | undefined;
  do {
    const page = await lister.listStores({
      pageSize: 100,
      ...(continuationToken ? { continuationToken } : {}),
    });
    if (page.stores.some((s) => s.name === ADMIN_STORE_NAME)) {
      throw new Error(
        `a store named ${ADMIN_STORE_NAME} already exists; grant roles by writing tuples to it`,
      );
    }
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);

  const { id: storeId } = await lister.createStore({ name: ADMIN_STORE_NAME });
  const modelId = await writeModel(modelFile, {
    apiUrl: target.apiUrl,
    storeId,
  });
  await new OpenFgaClient({
    apiUrl: target.apiUrl,
    storeId,
    authorizationModelId: modelId,
  }).write({
    writes: [
      {
        user: `user:${target.admin}`,
        relation: "security_admin",
        object: `organization:${target.organization}`,
      },
    ],
  });
  return { storeId, modelId };
}
