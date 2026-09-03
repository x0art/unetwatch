"""Task 12 Step 3 — query builder tests (spec §5.1/§5.2)."""

from app.routes.settings import FieldMap
from app.services.query_builder import QueryBuilder, time_range_to_es

DEFAULT_FIELD_MAP = FieldMap()


def test_query_builder_translates_filters():
    body = QueryBuilder.build(
        {
            "globalSearch": "192.168.1.45",
            "timeRange": "24h",
            "action": "DENY",
        },
        field_map=DEFAULT_FIELD_MAP,
    )
    assert "query" in body
    assert "range" in str(body)  # time range applied
    assert "192.168.1.45" in str(body)


def test_query_builder_uses_custom_field_map():
    """Custom FieldMap dotted paths replace the defaults in the body."""
    fm = FieldMap()
    fm.src_ip = "client_ip"
    fm.dest_ip = "server_ip"
    fm.url = "url.full"
    fm.domain = "url.domain"
    fm.timestamp = "log_timestamp"
    fm.action = "verdict"

    body = QueryBuilder.build(
        {
            "globalSearch": "10.0.0.1",
            "timeRange": "7d",
            "action": "ALLOW",
        },
        field_map=fm,
    )
    assert "client_ip" in str(body)  # multi_match uses mapped src/dest fields
    assert "log_timestamp" in str(body)  # range + sort on mapped timestamp
    assert {"term": {"verdict": "allow"}} in body["query"]["bool"]["must"]


def test_query_builder_kql_to_dsl():
    """KQL → ES DSL: field:value pairs become term clauses, bare text multi_match."""
    clauses = QueryBuilder.kql_to_dsl(
        "url.full: *streaming* AND event.action: deny", DEFAULT_FIELD_MAP
    )
    assert clauses == [
        {"term": {"url.full": "*streaming*"}},
        {"term": {"event.action": "deny"}},
    ]

    bare = QueryBuilder.kql_to_dsl("192.168.1.45", DEFAULT_FIELD_MAP)
    assert bare[0]["multi_match"]["query"] == "192.168.1.45"


def test_time_range_to_es():
    assert time_range_to_es("24h") == "now-24h"
    assert time_range_to_es("7d") == "now-7d"
    assert time_range_to_es("30d") == "now-30d"
    assert time_range_to_es("") is None
    assert time_range_to_es("all") is None
