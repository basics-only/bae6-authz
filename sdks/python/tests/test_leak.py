import asyncio
import traceback

import pytest
from bae6_authz import Authz, AuthzTransportError


# A variable, so the traceback's quoted source line doesn't contain the secret itself.
TOKEN = "SECRET\nX"


def test_transport_error_does_not_carry_the_end_user_token() -> None:
    async def call() -> None:
        async with Authz("http://127.0.0.1:9", "svc-token", "crm") as authz:
            # A newline is an invalid header value, which the HTTP layer rejects while quoting it.
            await authz.check(action="read", resource="document:d1", end_user_token=TOKEN)

    with pytest.raises(AuthzTransportError) as raised:
        asyncio.run(call())

    assert "SECRET" not in "".join(traceback.format_exception(raised.value))
