import { OpenFgaClient } from "@openfga/sdk";
import type pg from "pg";

export class ApplicationNotFound extends Error {
  constructor(applicationId: string) {
    super(`application not found: ${applicationId}`);
  }
}

export class NoActiveModel extends Error {
  constructor(applicationId: string) {
    super(`application ${applicationId} has no active model binding`);
  }
}

export interface Binding {
  storeId: string;
  modelId: string;
}

/**
 * Reads an application's store and active model from the database; null if the
 * organization has no such application, which includes another tenant's.
 */
export type Lookup = (
  organization: string,
  applicationId: string,
) => Promise<{ storeId: string; modelId: string | null } | null>;

export function dbLookup(pool: pg.Pool): Lookup {
  return async (organization, applicationId) => {
    const { rows } = await pool.query<{
      store_id: string;
      model_id: string | null;
    }>(
      `SELECT a.store_id, b.model_id
         FROM applications a
         LEFT JOIN model_bindings b
           ON b.organization_id = a.organization_id AND b.application_id = a.id
          AND b.active
        WHERE a.organization_id = $1 AND a.id = $2`,
      [organization, applicationId],
    );
    return rows[0]
      ? { storeId: rows[0].store_id, modelId: rows[0].model_id }
      : null;
  };
}

/**
 * Maps an application to its OpenFGA store and pinned model using only the
 * database. It never falls back to another store or to "latest": an unknown
 * application or one without an active model is an error, and no client exists.
 */
export function createResolver(lookup: Lookup, apiUrl: string) {
  async function resolve(
    organization: string,
    applicationId: string,
  ): Promise<Binding> {
    const found = await lookup(organization, applicationId);
    if (!found) throw new ApplicationNotFound(applicationId);
    if (!found.modelId) throw new NoActiveModel(applicationId);
    return { storeId: found.storeId, modelId: found.modelId };
  }

  return {
    resolve,
    /** A client that always sends the pinned model ID. */
    async clientFor(
      organization: string,
      applicationId: string,
    ): Promise<OpenFgaClient> {
      const { storeId, modelId } = await resolve(organization, applicationId);
      return new OpenFgaClient({
        apiUrl,
        storeId,
        authorizationModelId: modelId,
      });
    },
  };
}
