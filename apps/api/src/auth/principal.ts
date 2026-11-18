/** An organization ID (the tenant, bae6-contracts ADR-0002); also an OpenFGA object ID. */
export const ORGANIZATION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The verified caller of a request. Handlers receive this, never raw credentials. */
export interface Principal {
  subject: string;
  /** The tenant, mapped from configuration (the token's issuer), never from the request. */
  organization: string;
  scopes: readonly string[];
  /** Application IDs this caller may act on. */
  applications: readonly string[];
  /** The workload's verified client identity; set when it authenticated with a token. */
  clientId?: string;
  /** The issuer that verified the token; set with `clientId`. */
  issuer?: string;
  /** Set when the token was minted for administration (the issuer's `adminAudience`). */
  admin?: true;
}

/**
 * Resolves an end-user token, presented by `caller`, to the verified end-user
 * subject, or null if it is not valid. Throws if that could not be determined.
 */
export type EndUserVerifier = (
  token: string | undefined,
  caller: Principal,
) => string | null | Promise<string | null>;

/**
 * Resolves an `Authorization` header to a Principal, or null if it is not valid.
 * Throws if that could not be determined; the server then fails the request.
 */
export type Authenticator = (
  authorization: string | undefined,
) => Principal | null | Promise<Principal | null>;
