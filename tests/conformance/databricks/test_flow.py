"""The authz + Unity Catalog flow of examples/databricks, against local stand-ins for both.

authz is a local HTTP server and Databricks is a mock transport, so this proves the flow, not
a real workspace; see examples/databricks/README.md for what is unverified.
"""

import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx
import pytest
from bae6_authz import Authz
from bae6_authz.databricks import Databricks

sys.path.insert(0, str(Path(__file__).parents[3] / "examples/databricks"))
from app import handle  # noqa: E402

TOKEN = {"x-forwarded-access-token": "user-token"}
ROWS = {
    "statement_id": "st-1",
    "status": {"state": "SUCCEEDED"},
    "manifest": {"schema": {"columns": [{"name": "id"}]}},
    "result": {"data_array": [["1"]]},
}
UC_DENIED = {
    "statement_id": "st-2",
    "status": {
        "state": "FAILED",
        "error": {"error_code": "PERMISSION_DENIED", "message": "no SELECT"},
    },
}


def _run(
    headers: dict[str, str],
    authz_answer: dict[str, Any],
    databricks_answer: dict[str, Any],
    report: str = "sales",
) -> tuple[int, dict[str, object], list[httpx.Request], list[dict[str, Any]]]:
    authz_calls: list[dict[str, Any]] = []

    class AuthzStub(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            authz_calls.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            body = json.dumps(authz_answer).encode()
            self.send_response(200)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), AuthzStub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    db_calls: list[httpx.Request] = []

    def databricks(request: httpx.Request) -> httpx.Response:
        db_calls.append(request)
        return httpx.Response(200, json=databricks_answer)

    async def go() -> tuple[int, dict[str, object]]:
        async with (
            Authz(f"http://127.0.0.1:{server.server_port}", "svc", "crm") as authz,
            Databricks(
                "dbc-1.cloud.databricks.com", "wh1", transport=httpx.MockTransport(databricks)
            ) as db,
        ):
            return await handle(headers, report, authz=authz, db=db)

    try:
        status, body = asyncio.run(go())
    finally:
        server.shutdown()
    return status, body, db_calls, authz_calls


def test_riz_and_unity_catalog_both_allow_so_the_user_gets_rows() -> None:
    status, body, db_calls, authz_calls = _run(TOKEN, {"status": "allow", "requestId": "r1"}, ROWS)

    assert (status, body["rows"]) == (200, [["1"]])
    assert authz_calls[0]["object"] == "report:sales"
    assert db_calls[0].headers["authorization"] == "Bearer user-token"


def test_unity_catalog_denies_a_user_even_though_riz_allows() -> None:
    status, body, db_calls, _ = _run(TOKEN, {"status": "allow", "requestId": "r1"}, UC_DENIED)

    assert (status, body) == (403, {"error": "denied by databricks"})
    assert len(db_calls) == 1


def test_databricks_is_not_queried_when_riz_denies() -> None:
    status, body, db_calls, _ = _run(TOKEN, {"status": "deny", "requestId": "r1"}, ROWS)

    assert (status, body) == (403, {"error": "denied by authz"})
    assert db_calls == []


def test_databricks_is_not_queried_when_riz_cannot_decide() -> None:
    answer = {"status": "indeterminate", "code": "authorization_unavailable", "requestId": "r1"}
    status, _, db_calls, _ = _run(TOKEN, answer, ROWS)

    assert status == 503
    assert db_calls == []


@pytest.mark.parametrize("headers", [{}, {"authorization": "Bearer service-principal"}])
def test_without_the_users_token_nothing_is_asked_of_riz_or_databricks(
    headers: dict[str, str],
) -> None:
    status, _, db_calls, authz_calls = _run(headers, {"status": "allow", "requestId": "r1"}, ROWS)

    assert status == 401
    assert db_calls == []
    assert authz_calls == []


def test_an_unknown_report_reaches_neither_riz_nor_databricks() -> None:
    status, _, db_calls, authz_calls = _run(
        TOKEN, {"status": "allow", "requestId": "r1"}, ROWS, report="x; DROP TABLE t"
    )

    assert status == 404
    assert db_calls == []
    assert authz_calls == []
