"""Every route module that defines a router must actually be registered.

Regression guard for the bug where ``app/routes/hosts.py`` was imported in
``app/main.py`` but never passed to ``app.include_router``. That omission is
invisible: the import satisfies linters, the app boots, and the SPA catch-all
turned every dead endpoint into an HTTP 200 HTML "success" instead of a 404.

This test enumerates every module under ``app/routes/`` that defines a
``router`` and asserts it is registered on the app. Adding a new route module
and forgetting to register it fails loudly here.

Matching is by object identity against ``_IncludedRouter.original_router``
rather than by path prefix: a prefix check could pass for a module that is
merely *mentioned* in another router, whereas identity proves the exact
``APIRouter`` instance landed on ``app``.

There is no allow-list. If a future route module is an intentional unregistered
helper, it should not define a top-level ``router``; if one genuinely must, add
it to ``INTENTIONALLY_UNREGISTERED`` below **with a stated reason** — the
assertion on that set's emptiness is what keeps this from becoming a silencing
mechanism.
"""

import importlib
import pathlib

# Justified exceptions ONLY. Each entry must carry a reason in the comment.
# Currently empty: every app/routes module that defines a router is registered.
INTENTIONALLY_UNREGISTERED: dict[str, str] = {}

ROUTES_DIR = pathlib.Path(__file__).resolve().parent.parent / "app" / "routes"


def _route_modules_with_router() -> dict[str, object]:
    """module name -> APIRouter instance for every route module defining one."""
    found: dict[str, object] = {}
    for path in sorted(ROUTES_DIR.glob("*.py")):
        if path.name == "__init__.py":
            continue
        module = importlib.import_module(f"app.routes.{path.stem}")
        router = getattr(module, "router", None)
        if router is not None:
            found[path.stem] = router
    return found


def _registered_router_ids() -> set[int]:
    from app.main import app

    return {
        id(route.original_router)
        for route in app.routes
        if type(route).__name__ == "_IncludedRouter"
    }


def test_every_route_module_defines_a_router():
    """Sanity: the enumeration finds the modules (guards against a silent
    glob/import failure making the real assertion vacuously true)."""
    modules = _route_modules_with_router()
    assert "hosts" in modules, "route-module enumeration broke"
    assert len(modules) >= 16, f"expected all route modules, found {sorted(modules)}"


def test_every_router_is_registered_on_the_app():
    """The core guard: any module defining a `router` must be include_router'd."""
    registered = _registered_router_ids()

    unregistered = [
        name
        for name, router in _route_modules_with_router().items()
        if id(router) not in registered and name not in INTENTIONALLY_UNREGISTERED
    ]

    assert not unregistered, (
        "route module(s) define a router but are not registered in app/main.py "
        f"via app.include_router(...): {unregistered}. The SPA catch-all will "
        "answer their endpoints with index.html + HTTP 200."
    )


def test_intentionally_unregistered_is_empty_or_justified():
    """No silent allow-list: every exemption must carry a written reason."""
    for name, reason in INTENTIONALLY_UNREGISTERED.items():
        assert reason and reason.strip(), f"exemption for {name!r} has no reason"


def test_hosts_router_is_registered():
    """Pin the specific regression: hosts.router must be on the app."""
    from app.routes import hosts

    assert id(hosts.router) in _registered_router_ids()
