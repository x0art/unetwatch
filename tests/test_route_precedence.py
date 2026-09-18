"""Route precedence: the SPA catch-all must never shadow the JSON API.

Regression guard for the bug where ``GET /api/hosts/{ip}`` returned HTTP 200
with the SPA ``index.html`` body (text/html) instead of JSON, because
``app/routes/hosts.py`` imported its router but never registered it, so the
request fell through to the ``/{full_path:path}`` catch-all.

The catch-all is only mounted when ``admin-ui/dist`` exists at import time
(``app/main.py``: ``if os.path.isdir(_ADMIN_DIST)``). That is exactly why the
bug reproduced in CI/tests (where a frontend build is present) and hid in a
bare checkout. These tests therefore make the mount condition explicit: if the
build is absent they skip rather than silently pass without exercising the
catch-all.
"""

import os

import pytest

from app.main import _ADMIN_DIST

requires_dist = pytest.mark.skipif(
    not os.path.isdir(_ADMIN_DIST),
    reason="SPA mount is conditional on admin-ui/dist; not present in this checkout",
)


@requires_dist
async def test_api_host_profile_is_json_not_spa_html(client):
    """The hosts router must win over the SPA catch-all (the original bug).

    Pins the fix: /api/hosts/{ip} must be served by the API (JSON / auth
    JSON), never by the index.html catch-all.
    """
    res = client.get("/api/hosts/1.2.3.4")

    # Not the SPA shell. With admin auth (the `client` fixture sends it) this is
    # a 200 JSON profile; without, a JSON 401 — either way, never text/html.
    assert "text/html" not in res.headers.get("content-type", "")
    assert res.headers.get("content-type", "").startswith("application/json")
    assert res.status_code in (200, 401)
    if res.status_code == 200:
        assert res.json()["ip"] == "1.2.3.4"


@requires_dist
async def test_unknown_api_path_returns_json_404_not_spa(client):
    """General form of the bug class: an unmatched /api/... path must 404 as
    JSON, not answer with index.html + HTTP 200."""
    res = client.get("/api/this-route-does-not-exist")

    assert res.status_code == 404
    assert "text/html" not in res.headers.get("content-type", "")
    assert res.headers.get("content-type", "").startswith("application/json")


@requires_dist
async def test_spa_deep_link_still_returns_html(client):
    """The fix must not break genuine SPA deep links.

    /blockDomain and /whitelistDomain are standalone path-based routes read
    from window.location.pathname in admin-ui/src/App.tsx, so the server must
    still hand them index.html.
    """
    for path in ("/dashboard", "/blockDomain", "/whitelistDomain"):
        res = client.get(path)
        assert res.status_code == 200, path
        assert res.headers.get("content-type", "").startswith("text/html"), path
        assert "<!doctype html" in res.text.lower(), path


# ── Mount-independent guards ────────────────────────────────────────────────
# The tests above skip when admin-ui/dist is absent. These do not: they pin
# the guard predicate directly, so the "API path must not be answered with the
# SPA shell" rule stays tested on a bare checkout with no frontend build.


def test_is_api_reserved_path_covers_api_and_health():
    """The catch-all's guard must reject api + health (exact and prefixed)."""
    from app.main import is_api_reserved_path

    for path in ("api", "api/", "api/hosts/1.2.3.4", "api/anything", "health", "health/"):
        assert is_api_reserved_path(path), path


def test_is_api_reserved_path_allows_spa_routes():
    """The guard must NOT swallow genuine SPA deep links, and must not
    false-positive on paths that merely start with the same letters."""
    from app.main import is_api_reserved_path

    for path in ("", "dashboard", "blockDomain", "whitelistDomain", "apiary", "healthcheck"):
        assert not is_api_reserved_path(path), path
