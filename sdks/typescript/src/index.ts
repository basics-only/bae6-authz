export interface AuthzOptions {
  baseUrl: string;
  /** Bearer token identifying this workload to authz. */
  credentials: string;
  application: string;
  /** Total time allowed per request. Defaults to 5000. */
  timeoutMs?: number;
}

export interface Check {
  action: string;
  resource: string;
}

/**
 * `higher_consistency` sees revocations already committed, at more cost. Unset uses
 * authz's default, `minimize_latency`, which may serve a briefly cached answer.
 */
export type Consistency = "minimize_latency" | "higher_consistency";

/** `allowed` is true only for `allow`; an undecidable check raises instead. */
export interface Decision {
  allowed: boolean;
  status: "allow" | "deny";
  requestId: string;
  modelId?: string;
}

export interface ItemDecision {
  allowed: boolean;
  status: "allow" | "deny" | "indeterminate";
}

export interface BatchDecision {
  requestId: string;
  modelId?: string;
  /** One per input check, in input order. */
  results: ItemDecision[];
}

export class AuthzError extends Error {
  readonly requestId: string | undefined;
  constructor(message: string, requestId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.requestId = requestId;
  }
}

/** authz answered with something other than a decision. */
export class AuthzApiError extends AuthzError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    requestId?: string,
  ) {
    super(message, requestId);
  }
}

/** 401 or 403: bad workload or end-user credentials, or a missing scope. */
export class AuthzAuthError extends AuthzApiError {}

/** 400: authz rejected the request. */
export class AuthzValidationError extends AuthzApiError {}

/** authz could not decide (for example its authorization backend timed out). */
export class AuthzIndeterminateError extends AuthzError {
  constructor(
    readonly code: string | undefined,
    requestId: string,
  ) {
    super(
      `authz could not decide${code ? ` (${code})` : ""}; treat as denied`,
      requestId,
    );
  }
}

/** authz was not reached or did not answer. */
export class AuthzTransportError extends AuthzError {}

export class AuthzTimeoutError extends AuthzTransportError {}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function httpError(status: number, parsed: unknown): AuthzApiError {
  const body = isObject(parsed) ? parsed : {};
  const Err =
    status === 400
      ? AuthzValidationError
      : status === 401 || status === 403
        ? AuthzAuthError
        : AuthzApiError;
  return new Err(
    status,
    str(body.code),
    str(body.message) ?? `authz returned HTTP ${status}`,
    str(body.requestId),
  );
}

const invalidResponse = () =>
  new AuthzApiError(
    200,
    "invalid_response",
    "authz returned an unusable response",
  );

// Anything that is not `allow` is not an allow; `indeterminate` is kept apart.
function itemDecision(status: string | undefined): ItemDecision {
  if (status === "allow") return { allowed: true, status };
  if (status === undefined || status === "indeterminate") {
    return { allowed: false, status: "indeterminate" };
  }
  return { allowed: false, status: "deny" };
}

export class Authz {
  readonly #baseUrl: string;
  readonly #credentials: string;
  readonly #application: string;
  readonly #timeoutMs: number;

  constructor(options: AuthzOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#credentials = options.credentials;
    this.#application = options.application;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /**
   * Whether `endUserToken`'s user holds `action` on `resource`. Raises
   * AuthzIndeterminateError when authz cannot decide; never resolves to allow then.
   */
  async check(
    input: Check & { endUserToken: string; consistency?: Consistency },
  ): Promise<Decision> {
    const body = await this.#post("/v1/check", input.endUserToken, {
      application: this.#application,
      relation: input.action,
      object: input.resource,
      ...(input.consistency === undefined
        ? {}
        : { consistency: input.consistency }),
    });
    const status = str(body.status);
    const requestId = str(body.requestId);
    if (status === undefined || requestId === undefined) {
      throw invalidResponse();
    }
    if (status === "indeterminate") {
      throw new AuthzIndeterminateError(str(body.code), requestId);
    }
    const allowed = status === "allow";
    const modelId = str(body.modelId);
    return {
      allowed,
      status: allowed ? "allow" : "deny",
      requestId,
      ...(modelId === undefined ? {} : { modelId }),
    };
  }

  /** At most 100 checks (authz may allow fewer). One item being indeterminate does not affect the rest. */
  async batchCheck(
    checks: readonly Check[],
    options: { endUserToken: string; consistency?: Consistency },
  ): Promise<BatchDecision> {
    const body = await this.#post("/v1/batch-check", options.endUserToken, {
      application: this.#application,
      checks: checks.map((c, i) => ({
        correlationId: String(i),
        relation: c.action,
        object: c.resource,
      })),
      ...(options.consistency === undefined
        ? {}
        : { consistency: options.consistency }),
    });
    const requestId = str(body.requestId);
    if (requestId === undefined || !Array.isArray(body.results)) {
      throw invalidResponse();
    }
    const byId = new Map<string, string | undefined>();
    for (const r of body.results) {
      if (isObject(r) && typeof r.correlationId === "string") {
        // A repeated ID is ambiguous, so neither answer is used.
        byId.set(
          r.correlationId,
          byId.has(r.correlationId) ? undefined : str(r.status),
        );
      }
    }
    const modelId = str(body.modelId);
    return {
      requestId,
      ...(modelId === undefined ? {} : { modelId }),
      results: checks.map((_, i) => itemDecision(byId.get(String(i)))),
    };
  }

  async #post(
    path: string,
    endUserToken: string,
    payload: Json,
  ): Promise<Json> {
    let status: number;
    let text: string;
    try {
      const res = await fetch(this.#baseUrl + path, {
        method: "POST",
        // The end-user token must not follow a redirect to another host.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${this.#credentials}`,
          "bae6-end-user-token": endUserToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      status = res.status;
      text = await res.text();
    } catch (cause) {
      if (cause instanceof Error && cause.name === "TimeoutError") {
        throw new AuthzTimeoutError(
          `authz did not answer within ${this.#timeoutMs} ms`,
          undefined,
          { cause },
        );
      }
      // No `cause`: fetch's error can quote a header value, i.e. the end-user token.
      throw new AuthzTransportError(
        `could not reach authz (${cause instanceof Error ? cause.name : "error"})`,
      );
    }
    const parsed = parseJson(text);
    if (status !== 200) throw httpError(status, parsed);
    if (!isObject(parsed)) throw invalidResponse();
    return parsed;
  }
}
