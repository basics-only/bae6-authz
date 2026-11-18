# Express example

`index.js` serves `GET /documents/:id` and calls `authz.check({ action: "read", ... })` with
the caller's own bearer token. bae6-authz allowing returns 200; bae6-authz denying returns 403; a missing
or unknown token returns 401; bae6-authz unreachable or unable to decide returns 503, never an
allow.

Do the [setup](../README.md#setup-fastapi-and-express) first, then from the repo root:

```sh
pnpm install
pnpm --filter @bae6/authz build
PORT=8102 pnpm --filter @bae6/authz-example-express start
```

In another terminal:

```sh
curl -i localhost:8102/documents/d1 -H 'authorization: Bearer dev-alice-token'   # 200
curl -i localhost:8102/documents/d2 -H 'authorization: Bearer dev-alice-token'   # 403
curl -i localhost:8102/documents/d1                                              # 401
```

The SDK is linked from this checkout (`sdks/typescript`) because it is not published yet.
