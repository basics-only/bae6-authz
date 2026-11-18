import type pg from "pg";
import { recordAudit } from "../admin/audit.js";
import { ApplicationNotFound } from "../checks/resolver.js";
import type { TokenVerifier } from "./oidc.js";
import type { Authenticator, EndUserVerifier } from "./principal.js";

export interface WorkloadBinding {
  issuer: string;
  workload: string;
  application: string;
}

/** Application IDs a workload is bound to, within its organization. */
export type BindingLookup = (
  organization: string,
  issuer: string,
  workload: string,
) => Promise<string[]>;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * Authenticates a workload by its verified OIDC token. It is granted `check`
 * and nothing else (least privilege), on only the applications bound to it.
 */
export function workloadAuthenticator(
  verify: TokenVerifier,
  lookup: BindingLookup,
): Authenticator {
  return async (authorization) => {
    const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
    if (!token) return null;
    const verified = await verify(token);
    if (!verified) return null;
    const { azp, client_id: clientId } = verified.claims;
    const workload = [azp, clientId].find(nonEmpty) ?? verified.subject;
    return {
      subject: `${verified.issuer}|${workload}`,
      organization: verified.organization,
      scopes: ["check"],
      applications: await lookup(
        verified.organization,
        verified.issuer,
        workload,
      ),
      clientId: workload,
      issuer: verified.issuer,
      ...(verified.admin ? { admin: true as const } : {}),
    };
  };
}

/**
 * The end user is the token's verified `sub`, and only if the token was issued
 * to the calling workload (`azp`), so another workload cannot replay it, by an
 * issuer of the caller's own organization.
 */
export function oidcEndUserVerifier(verify: TokenVerifier): EndUserVerifier {
  return async (token, caller) => {
    if (!token || !caller.clientId) return null;
    const verified = await verify(token);
    if (
      !verified ||
      verified.claims.azp !== caller.clientId ||
      verified.organization !== caller.organization
    ) {
      return null;
    }
    return verified.subject;
  };
}

export function createBindingStore(pool: pg.Pool) {
  async function audited(
    actor: string,
    organization: string,
    action: string,
    b: WorkloadBinding,
    sql: string,
    bound: boolean,
    requestId: string | undefined,
  ): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(sql, [
        b.issuer,
        b.workload,
        organization,
        b.application,
      ]);
      // An idempotent repeat changes nothing, so it is not an event.
      if (rowCount) {
        const binding = { issuer: b.issuer, workload: b.workload };
        await recordAudit(client, {
          actor,
          organization,
          action,
          applicationId: b.application,
          requestId,
          detail: bound
            ? { before: null, after: binding }
            : { before: binding, after: null },
        });
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      if ((err as { code?: string }).code === "23503") {
        throw new ApplicationNotFound(b.application);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    lookup: (async (organization, issuer, workload) => {
      const { rows } = await pool.query<{ application_id: string }>(
        `SELECT application_id FROM workload_bindings
          WHERE issuer = $1 AND workload = $2 AND organization_id = $3`,
        [issuer, workload, organization],
      );
      return rows.map((r) => r.application_id);
    }) satisfies BindingLookup,

    bind: (
      actor: string,
      organization: string,
      b: WorkloadBinding,
      requestId?: string,
    ) =>
      audited(
        actor,
        organization,
        "workloads.bind",
        b,
        `INSERT INTO workload_bindings (issuer, workload, organization_id, application_id)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        true,
        requestId,
      ),

    unbind: (
      actor: string,
      organization: string,
      b: WorkloadBinding,
      requestId?: string,
    ) =>
      audited(
        actor,
        organization,
        "workloads.unbind",
        b,
        `DELETE FROM workload_bindings
          WHERE issuer = $1 AND workload = $2 AND organization_id = $3
            AND application_id = $4`,
        false,
        requestId,
      ),
  };
}

export type BindingStore = ReturnType<typeof createBindingStore>;
