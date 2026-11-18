import type pg from "pg";
import { recordAudit } from "../admin/audit.js";

export interface DatabricksConfig {
  workspaceHost: string;
  warehouseId: string;
}

export class ProviderNotConfigured extends Error {}
export class ApplicationMissing extends Error {}

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Non-secret provider settings per application. Each mutation and its audit row commit
 * in one transaction, so an unaudited change cannot happen.
 */
export function createProviderService(deps: { pool: pg.Pool }) {
  const { pool } = deps;

  async function audited<T>(
    event: Parameters<typeof recordAudit>[1],
    mutate: (db: pg.PoolClient) => Promise<T>,
  ): Promise<{ auditEventId: string; result: T }> {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const auditEventId = await recordAudit(db, event);
      const result = await mutate(db);
      await db.query("COMMIT");
      return { auditEventId, result };
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }

  return {
    async get(
      organization: string,
      application: string,
    ): Promise<DatabricksConfig> {
      const { rows } = await pool.query(
        `SELECT config FROM provider_configs
          WHERE organization_id = $1 AND application_id = $2 AND provider = 'databricks'`,
        [organization, application],
      );
      if (rows.length === 0) throw new ProviderNotConfigured();
      return rows[0].config as DatabricksConfig;
    },

    async put(
      actor: string,
      organization: string,
      application: string,
      config: DatabricksConfig,
      requestId?: string,
    ): Promise<string> {
      try {
        const { auditEventId } = await audited(
          {
            actor,
            organization,
            action: "providers.put",
            applicationId: application,
            requestId,
            detail: { provider: "databricks", config },
          },
          (db) =>
            db.query(
              `INSERT INTO provider_configs (organization_id, application_id, provider, config)
               VALUES ($1, $2, 'databricks', $3)
               ON CONFLICT (organization_id, application_id, provider)
               DO UPDATE SET config = EXCLUDED.config`,
              [organization, application, config],
            ),
        );
        return auditEventId;
      } catch (err) {
        // An application this organization does not have, including another tenant's.
        if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
          throw new ApplicationMissing();
        }
        throw err;
      }
    },

    async remove(
      actor: string,
      organization: string,
      application: string,
      requestId?: string,
    ): Promise<string> {
      const { auditEventId } = await audited(
        {
          actor,
          organization,
          action: "providers.delete",
          applicationId: application,
          requestId,
          detail: { provider: "databricks" },
        },
        async (db) => {
          const { rowCount } = await db.query(
            `DELETE FROM provider_configs
              WHERE organization_id = $1 AND application_id = $2 AND provider = 'databricks'`,
            [organization, application],
          );
          // Throwing rolls the audit row back: nothing changed, so nothing to record.
          if (rowCount === 0) throw new ProviderNotConfigured();
        },
      );
      return auditEventId;
    },
  };
}

export type ProviderService = ReturnType<typeof createProviderService>;
