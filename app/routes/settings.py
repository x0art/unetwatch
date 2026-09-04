"""System & Kibana Settings endpoints (spec §3.5) — Task 11.

Exposes the System Settings page contracts:

    GET  /api/settings/kibana            → current Kibana connection form
    PUT  /api/settings/kibana            → persist it
    POST /api/settings/test-connection   → ping the configured host with creds
    GET  /api/settings/field-map         → app-attribute ↔ Kibana-field mapping
    PUT  /api/settings/field-map         → persist it
    GET  /api/settings/alerts            → threshold + webhook rules
    PUT  /api/settings/alerts            → persist it

Persistence is a generic key/value store in the aiosqlite ``settings`` table
(key TEXT PRIMARY KEY, value TEXT JSON). No row for a key → the defaults are
returned (env-overridable via ``KIBANA_*`` config for the connection form), so
every GET is a valid 200 on first boot.
"""

import json
import time
from typing import Literal

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.config import get_settings
from app.database import get_db_conn

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ── Models (persisted as JSON under a single settings key) ─────────────────


class KibanaSettings(BaseModel):
    """Kibana/ES connection form (spec §3.5)."""

    host_url: str = "https://kibana-internal.corp.net:5601"
    index_pattern: str = "logstash-network-traffic-*"
    auth_type: Literal["apiKey", "basic", "oauth2"] = "apiKey"
    api_key: str | None = None


class FieldMap(BaseModel):
    """App-attribute → Kibana-log-field mapping (spec §3.5 Field Mapper).

    Defaults are the configured ``logstash-proxy-*`` index's flat schema
    (``client_ip``, ``server_ip``, ``url``, ``domain``, ``action`` as
    uppercase ALLOW/DENY/FLAG, ``duration_seconds``). The UI edits these so
    custom index schemas can be mapped without code changes; Task 12's
    QueryBuilder/Normalizer consume this mapping and fall back to the
    spec's nested-ECS shape (``source.ip``/``url.full``/``event.action``)
    when a flat field is absent from a document.
    """

    src_ip: str = "client_ip"
    dest_ip: str = "server_ip"
    url: str = "url"
    domain: str = "domain"
    timestamp: str = "@timestamp"
    action: str = "action"
    duration: str = "duration_seconds"


class AlertSettings(BaseModel):
    """Threshold + notification rules (spec §3.5)."""

    # DENY ratio that trips the alert (percent, 0..100).
    deny_ratio_pct: float = Field(5.0, ge=0, le=100)
    # Sliding window the ratio is measured over (minutes).
    window_minutes: int = Field(15, ge=1, le=43200)
    webhook_type: Literal["none", "slack", "msteams"] = "none"
    webhook_url: str = ""


# ── Settings store helpers (key/value JSON in the `settings` table) ────────


async def _get_setting(db, key: str, default: dict) -> dict:
    cursor = await db.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = await cursor.fetchone()
    if not row:
        return default
    try:
        value = json.loads(row["value"])
        return value if isinstance(value, dict) else default
    except (json.JSONDecodeError, TypeError):
        return default


async def _put_setting(db, key: str, value: dict) -> None:
    await db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
    await db.commit()


async def _load(db, key: str, defaults: BaseModel) -> dict:
    """Defaults first, then overlay any persisted overrides (partial PUTs)."""
    saved = await _get_setting(db, key, {})
    data = defaults.model_dump()
    data.update(saved)
    return data


async def load_field_map(db) -> FieldMap:
    """Public accessor for the persisted app-attribute → Kibana-field mapping.

    Returns the spec defaults when nothing has been saved yet. This is the
    chokepoint the query pipeline (Task 12 QueryBuilder/Normalizer) consumes
    so custom index schemas configured in System Settings apply everywhere.
    """
    data = await _load(db, "field-map", FieldMap())
    return FieldMap(**data)


async def load_alert_settings(db) -> AlertSettings:
    """Public accessor for the persisted alert/threshold rules.

    Returns the spec defaults when nothing has been saved yet. The monitor
    poll (``fetch_logs``) reads this so a webhook configured in System
    Settings (Alert Rules tab) actually drives delivery instead of the env
    var only.
    """
    data = await _load(db, "alerts", AlertSettings())
    return AlertSettings(**data)


# ── Kibana connection ───────────────────────────────────────────────────────


def _kibana_defaults() -> dict:
    """Connection-form defaults: .env ``KIBANA_*`` settings, else the model."""
    s = get_settings()
    try:
        return KibanaSettings(
            host_url=s.kibana_host_url,
            index_pattern=s.kibana_index_pattern,
            auth_type=s.kibana_auth_type,
            api_key=s.kibana_api_key or None,
        ).model_dump()
    except Exception:
        # A malformed KIBANA_* env value (e.g. an invalid auth_type) must not
        # 500 the settings page — fall back to the built-in defaults.
        return KibanaSettings().model_dump()


@router.get("/kibana")
async def get_kibana(db=Depends(get_db_conn)):
    return await _load(db, "kibana", KibanaSettings(**_kibana_defaults()))


@router.put("/kibana")
async def put_kibana(body: KibanaSettings, db=Depends(get_db_conn)):
    await _put_setting(db, "kibana", body.model_dump())
    return body


@router.post("/test-connection")
async def test_connection(body: KibanaSettings):
    """Ping the configured Kibana/ES host with the provided auth.

    Returns 200 with ``{ ok, latencyMs, status?, error? }`` — ``ok`` is
    True only for 2xx/3xx; 4xx (bad key, forbidden) and 5xx both surface as
    ``ok: False`` with the status, and a connection failure returns
    ``ok: False`` with the exception text. The page renders this inline
    next to the Test Connection button. Validation failures (bad auth_type,
    malformed URL) are rejected 422 by Pydantic.
    """
    headers = {}
    if body.api_key:
        headers["Authorization"] = f"ApiKey {body.api_key}"
    url = body.host_url.strip().rstrip("/")
    if not url:
        return {"ok": False, "latencyMs": 0, "error": "host_url is empty"}

    start = time.perf_counter()
    try:
        # verify=True by default: this is an internal Kibana host and the whole
        # point of the check is auth validity, so a self-signed/MITM TLS cert
        # must fail loudly instead of silently passing.
        async with httpx.AsyncClient(timeout=3) as client:
            resp = await client.get(url, headers=headers)
        latency_ms = round((time.perf_counter() - start) * 1000, 1)
        # Only 2xx/3xx mean the connection is usable. A 401/403 proves the host
        # is reachable but the provided auth is wrong — that must surface as
        # ok=False with the status, not a green "Connection OK".
        ok = 200 <= resp.status_code < 400
        return {
            "ok": ok,
            "latencyMs": latency_ms,
            "status": resp.status_code,
            **({"error": f"unexpected HTTP {resp.status_code}"} if not ok else {}),
        }
    except Exception as e:
        latency_ms = round((time.perf_counter() - start) * 1000, 1)
        return {"ok": False, "latencyMs": latency_ms, "error": str(e)}


# ── Field map ───────────────────────────────────────────────────────────────


@router.get("/field-map")
async def get_field_map(db=Depends(get_db_conn)):
    return await _load(db, "field-map", FieldMap())


@router.put("/field-map")
async def put_field_map(body: FieldMap, db=Depends(get_db_conn)):
    await _put_setting(db, "field-map", body.model_dump())
    return body


# ── Alert rules ─────────────────────────────────────────────────────────────


@router.get("/alerts")
async def get_alerts(db=Depends(get_db_conn)):
    return await _load(db, "alerts", AlertSettings())


@router.put("/alerts")
async def put_alerts(body: AlertSettings, db=Depends(get_db_conn)):
    await _put_setting(db, "alerts", body.model_dump())
    return body
