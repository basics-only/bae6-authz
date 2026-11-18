# Kubernetes manifests

Stateless API replicas and a single console, for a cluster that already has Postgres and
OpenFGA. Those two are external dependencies and are not managed here.

| File | Holds |
| --- | --- |
| `namespace.yaml` | the `bae6-authz` namespace |
| `api.yaml` | API config, Deployment (2 replicas), Service, PodDisruptionBudget, example HPA |
| `console.yaml` | console config, Deployment (1 replica), Service |

Probes: the API's liveness is `/health/live` (no dependencies) and readiness is
`/health/ready` (Postgres and OpenFGA), so an outage drains pods instead of restarting them.
The console has no health route and uses TCP probes.

## Before applying

1. Edit the placeholders in the two ConfigMaps: `OPENFGA_API_URL`, `BAE6_OIDC_ISSUERS`,
   `BAE6_ADMIN_STORE_ID` and `BAE6_ADMIN_MODEL_ID` (from `bootstrap-admin`, see
   [ADR 0004](../../docs/decisions/0004-admin-authorization.md)), and the console's `OIDC_*`
   values. Hosts ending in `.invalid` are placeholders.
2. Build and publish the images (`deploy/api.Dockerfile`, `deploy/console.Dockerfile`) and
   change the `image:` fields, or load local ones as below.
3. Create the secrets. Nothing secret is committed:

```
kubectl create namespace bae6-authz
kubectl -n bae6-authz create secret generic bae6-authz-api --from-literal=database-url='postgres://authz:<password>@<host>:5432/authz'
kubectl -n bae6-authz create secret generic bae6-authz-console --from-literal=oidc-client-secret='<secret>'
```

Run `pnpm --filter @bae6/authz-api migrate` (or let the first replica start; replicas serialize
migrations with a lock) against the database before sending traffic.

## Apply on a local kind cluster

```
docker build -f deploy/api.Dockerfile -t bae6-authz-api:local .
docker build -f deploy/console.Dockerfile -t bae6-authz-console:local .
kind create cluster --name bae6-authz
kind load docker-image bae6-authz-api:local bae6-authz-console:local --name bae6-authz
kubectl apply -f deploy/kubernetes/namespace.yaml
kubectl apply -f deploy/kubernetes/
kubectl -n bae6-authz rollout status deploy/bae6-authz-api
```

From kind on Docker Desktop, Postgres and OpenFGA published on the host are reachable as
`host.docker.internal`; use that in `database-url` and `OPENFGA_API_URL`.

## Status

- Schema validity is checked by kubeconform in CI.
- Applying to kind is **unverified**: it has not been run, and the placeholders must be set
  to real dependencies for the pods to become ready.
- The HPA needs a metrics-server, which kind does not ship.
- The console's in-memory sessions (ADR 0006) are why it is one replica.
