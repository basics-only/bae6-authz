import type { IncomingMessage, ServerResponse } from "node:http";
import type { EndUserVerifier, Principal } from "../auth/index.js";
import { HttpError, readJson, requestIdOf, send } from "../http.js";
import { recordBatchSize, recordDecisions } from "../observability.js";
import { ApplicationNotFound } from "./resolver.js";
import {
  type BatchItem,
  type CheckService,
  type Consistency,
  InvalidCheck,
} from "./service.js";

const APPLICATION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SUBJECT = /^[A-Za-z0-9._@+-]{1,128}$/;
const OBJECT = /^[a-z_]+:[^\s#]+$/;
const TYPE = /^[a-z_]+$/;
const LIST_LIMIT = 100;

function invalid(message: string) {
  return new HttpError(400, "invalid_request", message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOnly(b: Record<string, unknown>, keys: string[]) {
  return Object.keys(b).every((k) => keys.includes(k));
}

function isCheck(
  b: Record<string, unknown>,
): b is Record<string, unknown> & { relation: string; object: string } {
  return (
    typeof b.relation === "string" &&
    b.relation !== "" &&
    typeof b.object === "string" &&
    OBJECT.test(b.object)
  );
}

function applicationOf(b: Record<string, unknown>): string {
  if (typeof b.application !== "string" || !APPLICATION.test(b.application)) {
    throw invalid("application is required and must be a valid ID.");
  }
  return b.application;
}

function consistencyOf(b: Record<string, unknown>): Consistency | undefined {
  if (b.consistency === undefined) return undefined;
  if (
    b.consistency !== "minimize_latency" &&
    b.consistency !== "higher_consistency"
  ) {
    throw invalid(
      "consistency must be minimize_latency or higher_consistency.",
    );
  }
  return b.consistency;
}

function checkBody(body: unknown) {
  if (
    !isObject(body) ||
    !hasOnly(body, ["application", "relation", "object", "consistency"]) ||
    !isCheck(body)
  ) {
    throw invalid(
      "Body must be {application, relation, object} with valid values.",
    );
  }
  return {
    application: applicationOf(body),
    relation: body.relation,
    object: body.object,
    consistency: consistencyOf(body),
  };
}

function batchBody(body: unknown, maxBatchSize: number) {
  if (
    !isObject(body) ||
    !hasOnly(body, ["application", "checks", "consistency"])
  ) {
    throw invalid("Body must be {application, checks}.");
  }
  const application = applicationOf(body);
  const consistency = consistencyOf(body);
  const { checks } = body;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw invalid("checks must be a non-empty array.");
  }
  if (checks.length > maxBatchSize) {
    throw new HttpError(
      400,
      "batch_too_large",
      `A batch holds at most ${maxBatchSize} checks.`,
    );
  }
  const seen = new Set<string>();
  const items: BatchItem[] = checks.map((c: unknown) => {
    if (
      !isObject(c) ||
      !hasOnly(c, ["correlationId", "relation", "object"]) ||
      typeof c.correlationId !== "string" ||
      c.correlationId.length < 1 ||
      c.correlationId.length > 64 ||
      !isCheck(c)
    ) {
      throw invalid(
        "Each check must be {correlationId, relation, object} with valid values.",
      );
    }
    if (seen.has(c.correlationId)) {
      throw new HttpError(
        400,
        "duplicate_correlation_id",
        "correlationId must be unique within the batch.",
      );
    }
    seen.add(c.correlationId);
    return {
      correlationId: c.correlationId,
      relation: c.relation,
      object: c.object,
    };
  });
  return { application, items, consistency };
}

/** The cursor is the page's last object, base64url-encoded so callers treat it as opaque. */
const cursorOf = (object: string) => Buffer.from(object).toString("base64url");

function listBody(body: unknown) {
  if (
    !isObject(body) ||
    !hasOnly(body, [
      "application",
      "relation",
      "type",
      "limit",
      "cursor",
      "consistency",
    ]) ||
    typeof body.relation !== "string" ||
    body.relation === "" ||
    typeof body.type !== "string" ||
    !TYPE.test(body.type)
  ) {
    throw invalid(
      "Body must be {application, relation, type} with valid values.",
    );
  }
  const { limit = LIST_LIMIT, cursor } = body;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIST_LIMIT
  ) {
    throw invalid(`limit must be an integer from 1 to ${LIST_LIMIT}.`);
  }
  let after: string | undefined;
  if (cursor !== undefined) {
    after =
      typeof cursor === "string" && cursor.length <= 1024
        ? Buffer.from(cursor, "base64url").toString()
        : "";
    if (!OBJECT.test(after) || !after.startsWith(`${body.type}:`)) {
      throw invalid("cursor is not a cursor from this listing.");
    }
  }
  return {
    application: applicationOf(body),
    relation: body.relation,
    type: body.type,
    limit,
    after,
    consistency: consistencyOf(body),
  };
}

/** Returns true if the request was handled. Business logic lives in the service. */
export function checkRoutes(deps: {
  service: CheckService;
  verifyEndUser: EndUserVerifier;
  maxBatchSize: number;
}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    url: URL,
  ): Promise<boolean> => {
    const isBatch = url.pathname === "/v1/batch-check";
    const isList = url.pathname === "/v1/list-objects";
    if (
      !(isBatch || isList || url.pathname === "/v1/check") ||
      req.method !== "POST"
    ) {
      return false;
    }

    if (!principal.scopes.includes("check")) {
      throw new HttpError(403, "forbidden", "Missing scope check.");
    }
    // Riz-End-User-Token is still accepted until the next major (bae6-contracts ADR-0003).
    const header =
      req.headers["bae6-end-user-token"] ?? req.headers["riz-end-user-token"];
    const endUser = await deps.verifyEndUser(
      typeof header === "string" ? header : undefined,
      principal,
    );
    // The subject is spliced into an OpenFGA `user:<sub>` string, so it must not
    // be able to carry `#`, `*` or whitespace.
    if (!endUser || !SUBJECT.test(endUser)) {
      throw new HttpError(
        401,
        "invalid_end_user_token",
        "Missing or invalid end-user token.",
      );
    }
    const body = await readJson(req);
    const permit = (application: string) => {
      // Decided before the application is looked up, so a 403 says nothing about whether it exists.
      if (
        !principal.applications.includes("*") &&
        !principal.applications.includes(application)
      ) {
        throw new HttpError(
          403,
          "forbidden",
          "Caller is not permitted for this application.",
        );
      }
    };

    try {
      let result: object;
      if (isList) {
        const input = listBody(body);
        permit(input.application);
        const { after, ...page } = await deps.service.list(
          principal.organization,
          input.application,
          endUser,
          input,
        );
        result =
          after === undefined ? page : { ...page, nextCursor: cursorOf(after) };
      } else if (isBatch) {
        const { application, items, consistency } = batchBody(
          body,
          deps.maxBatchSize,
        );
        permit(application);
        recordBatchSize(items.length);
        const batch = await deps.service.batch(
          principal.organization,
          application,
          endUser,
          items,
          consistency,
        );
        recordDecisions(batch.results.map((r) => r.status));
        result = batch;
      } else {
        const input = checkBody(body);
        permit(input.application);
        const single = await deps.service.check(
          principal.organization,
          input.application,
          endUser,
          input,
        );
        recordDecisions([single.status]);
        result = single;
      }
      send(res, 200, { ...result, requestId: requestIdOf(res) });
    } catch (err) {
      if (err instanceof ApplicationNotFound) {
        throw new HttpError(404, "not_found", "Application not found.");
      }
      if (err instanceof InvalidCheck) {
        throw invalid("Unknown relation or object type for this application.");
      }
      throw err;
    }
    return true;
  };
}
