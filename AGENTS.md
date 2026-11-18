# AGENTS.md — bae6-authz

Follow the shared bae6 guide first: [bae6-contracts/AGENTS.md](https://github.com/basics-only/bae6-contracts/blob/main/AGENTS.md). This file adds only what is specific to authorization.

## Mission
A minimal, secure authorization API on OpenFGA. Do not implement a policy engine or duplicate OpenFGA evaluation logic.

## Architecture
- apps/api: TypeScript HTTP API
- apps/console: SvelteKit admin frontend (kept in the repo, not released in v1)
- sdks/python, sdks/typescript: thin, stateless SDKs
- models/openfga: version-controlled authorization models
- contracts: API contract
- deploy: local and production deployment configuration

Data-provider adapters preserve the source's native authorization. Never copy source-system privileges into OpenFGA as a substitute for native enforcement.

## Rules
- Keep business logic out of route handlers.
- Never silently substitute privileged service credentials for user credentials.
- Treat authorization model changes as versioned migrations.
- Every permission mutation is authorized and audited.
- Scope every application to its approved OpenFGA store and pinned model.
- Keep check permissions separate from administrative mutation permissions.
- Never log access tokens or protected data.
- Every new authorization feature gets negative permission tests.
- Mark integration tests against external enterprise systems (Databricks, OIDC providers) as unverified until run against real infrastructure.
