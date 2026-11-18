import {
  ConsistencyPreference,
  FgaApiValidationError,
  type OpenFgaClient,
} from "@openfga/sdk";
import { observeOpenFga, traceHeaders } from "../observability.js";
import {
  ApplicationNotFound,
  type createResolver,
  NoActiveModel,
} from "./resolver.js";

/** Absent means OpenFGA's own default, which is `minimize_latency`. */
export type Consistency = "minimize_latency" | "higher_consistency";

export type Decision = "allow" | "deny" | "indeterminate";
export type IndeterminateCode = "timeout" | "backend_error" | "no_active_model";

export interface CheckResult {
  status: Decision;
  modelId?: string;
  /** Why the decision is indeterminate; absent otherwise. */
  code?: IndeterminateCode;
}

export interface BatchItem {
  correlationId: string;
  relation: string;
  object: string;
}

export interface BatchResult {
  modelId?: string;
  results: { correlationId: string; status: Decision }[];
}

export interface ListPage {
  objects: string[];
  /** The last object of this page, when more follow. */
  after?: string;
  modelId?: string;
  code?: IndeterminateCode;
}

/** The request is malformed for this application's model (unknown type or relation). */
export class InvalidCheck extends Error {}

class Timeout extends Error {}

/**
 * Checks permissions for `user:<endUser>` in the application's store against
 * its pinned model. Any failure to reach a decision is `indeterminate`, never allow.
 */
export function createCheckService(deps: {
  resolver: ReturnType<typeof createResolver>;
  timeoutMs: number;
}) {
  const { resolver, timeoutMs } = deps;

  /**
   * Runs `call` against the application's pinned client under the timeout.
   * `fail` builds the answer when no decision can be made.
   */
  async function guarded<T>(
    organization: string,
    applicationId: string,
    operation: "check" | "batch_check" | "list_objects",
    call: (client: OpenFgaClient, modelId: string) => Promise<T>,
    fail: (code: IndeterminateCode) => T,
  ): Promise<T> {
    let client: OpenFgaClient;
    try {
      client = await resolver.clientFor(organization, applicationId);
    } catch (err) {
      if (err instanceof ApplicationNotFound) throw err;
      if (err instanceof NoActiveModel) return fail("no_active_model");
      // Database failure: no decision can be made.
      return fail("backend_error");
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      // shortcut: on timeout the OpenFGA request is abandoned, not cancelled
      // (the SDK takes no abort signal); upgrade if abandoned calls pile up.
      return await observeOpenFga(operation, () =>
        Promise.race([
          // clientFor always pins a model ID.
          call(client, client.authorizationModelId as string),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Timeout()), timeoutMs);
          }),
        ]),
      );
    } catch (err) {
      if (err instanceof FgaApiValidationError) throw new InvalidCheck();
      return fail(err instanceof Timeout ? "timeout" : "backend_error");
    } finally {
      clearTimeout(timer);
    }
  }

  const requestOptions = (consistency: Consistency | undefined) => ({
    retryParams: { maxRetry: 0 },
    headers: traceHeaders(),
    ...(consistency === undefined
      ? {}
      : {
          consistency:
            consistency === "higher_consistency"
              ? ConsistencyPreference.HigherConsistency
              : ConsistencyPreference.MinimizeLatency,
        }),
  });

  return {
    check(
      organization: string,
      applicationId: string,
      endUser: string,
      input: {
        relation: string;
        object: string;
        consistency?: Consistency | undefined;
      },
    ): Promise<CheckResult> {
      return guarded<CheckResult>(
        organization,
        applicationId,
        "check",
        async (client, modelId) => {
          const { allowed } = await client.check(
            {
              user: `user:${endUser}`,
              relation: input.relation,
              object: input.object,
            },
            requestOptions(input.consistency),
          );
          return { status: allowed === true ? "allow" : "deny", modelId };
        },
        (code) => ({ status: "indeterminate", code }),
      );
    },

    /** One result per item, matched to OpenFGA's answers by correlation ID. */
    batch(
      organization: string,
      applicationId: string,
      endUser: string,
      items: BatchItem[],
      consistency?: Consistency,
    ): Promise<BatchResult> {
      const allIndeterminate = (): BatchResult => ({
        results: items.map((i) => ({
          correlationId: i.correlationId,
          status: "indeterminate",
        })),
      });
      return guarded<BatchResult>(
        organization,
        applicationId,
        "batch_check",
        async (client, modelId) => {
          const { result } = await client.batchCheck(
            {
              checks: items.map((i) => ({
                user: `user:${endUser}`,
                relation: i.relation,
                object: i.object,
                correlationId: i.correlationId,
              })),
            },
            requestOptions(consistency),
          );
          const byId = new Map(result.map((r) => [r.correlationId, r]));
          return {
            modelId,
            results: items.map((i) => {
              const r = byId.get(i.correlationId);
              // A missing answer or a per-item error is not a decision.
              const status: Decision =
                !r || r.error ? "indeterminate" : r.allowed ? "allow" : "deny";
              return { correlationId: i.correlationId, status };
            }),
          };
        },
        allIndeterminate,
      );
    },

    /**
     * One page of the objects of `type` the end user holds `relation` on, in ascending
     * order after `after`. OpenFGA has no pagination, so every page re-runs the listing.
     */
    list(
      organization: string,
      applicationId: string,
      endUser: string,
      input: {
        relation: string;
        type: string;
        limit: number;
        after?: string | undefined;
        consistency?: Consistency | undefined;
      },
    ): Promise<ListPage> {
      return guarded<ListPage>(
        organization,
        applicationId,
        "list_objects",
        async (client, modelId) => {
          // shortcut: bounded by OpenFGA's own result cap and deadline, beyond which
          // results are silently partial; upgrade to StreamedListObjects if lists outgrow it.
          const { objects } = await client.listObjects(
            {
              user: `user:${endUser}`,
              relation: input.relation,
              type: input.type,
            },
            requestOptions(input.consistency),
          );
          const { after } = input;
          const sorted = objects
            .filter((o) => after === undefined || o > after)
            .sort();
          const page = sorted.slice(0, input.limit);
          return {
            objects: page,
            modelId,
            ...(sorted.length > page.length
              ? { after: page[page.length - 1] as string }
              : {}),
          };
        },
        (code) => ({ objects: [], code }),
      );
    },
  };
}

export type CheckService = ReturnType<typeof createCheckService>;
