"""A report endpoint guarded by authz and by Unity Catalog (ADR 0007).

authz decides whether this user may open the report; Databricks decides, with the same user's
token, whether they may read the table behind it. Both must say yes. authz allowing is not
enough, and a Unity Catalog grant is not enough either.

Run one request by hand (see README.md):
    uv run python examples/databricks/app.py sales
"""

import asyncio
import os
import sys
from collections.abc import Mapping

from bae6_authz import Authz, AuthzError
from bae6_authz.databricks import (
    Databricks,
    DatabricksDeniedError,
    DatabricksError,
    MissingUserCredentialError,
    user_token_from_headers,
)

# Report name -> table. A fixed map, so a caller never chooses what reaches the SQL text.
REPORTS = {"sales": "main.sales.orders"}


async def handle(
    headers: Mapping[str, str], report: str, *, authz: Authz, db: Databricks
) -> tuple[int, dict[str, object]]:
    table = REPORTS.get(report)
    if table is None:
        return 404, {"error": "unknown report"}
    try:
        token = user_token_from_headers(headers)
    except MissingUserCredentialError:
        # No user, no query: this app never falls back to its own identity.
        return 401, {"error": "no user credential"}
    try:
        decision = await authz.check(
            action="read", resource=f"report:{report}", end_user_token=token
        )
    except AuthzError:
        # Includes "could not decide": an undecided check is a refusal.
        return 503, {"error": "authorization unavailable"}
    if not decision.allowed:
        return 403, {"error": "denied by authz"}
    try:
        result = await db.query(f"SELECT * FROM {table} LIMIT 10", user_token=token)
    except DatabricksDeniedError:
        return 403, {"error": "denied by databricks"}
    except DatabricksError:
        return 502, {"error": "databricks unavailable"}
    return 200, {"columns": result.columns, "rows": result.rows}


async def _main(report: str) -> None:
    async with (
        Authz(
            os.environ["BAE6_API_URL"],
            os.environ["BAE6_WORKLOAD_TOKEN"],
            os.environ["BAE6_APPLICATION"],
        ) as authz,
        Databricks(
            os.environ["BAE6_DATABRICKS_HOST"], os.environ["BAE6_DATABRICKS_WAREHOUSE_ID"]
        ) as db,
    ):
        headers = {"x-forwarded-access-token": os.environ.get("BAE6_USER_TOKEN", "")}
        status, body = await handle(headers, report, authz=authz, db=db)
        print(status, body)


if __name__ == "__main__":
    asyncio.run(_main(sys.argv[1]))
