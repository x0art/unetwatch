"""Task 12 Step 1 — normalizer tests (spec §5.2)."""

from app.routes.settings import FieldMap
from app.services.normalizer import Normalizer


def test_normalizer_maps_raw_to_app_state():
    raw = {
        "_id": "k8F3...",
        "_source": {
            "@timestamp": "2026-09-02T10:42:01.123Z",
            "source": {"ip": "192.168.1.45", "host": "Dev-Workstation-04", "bytes": 45210},
            "destination": {"ip": "185.220.101.4", "domain": "malicious-site.ru"},
            "url": {"full": "http://malicious-site.ru/auth/login.php?user=admin"},
            "event": {"action": "deny", "duration": 12},
            "rule": {"id": "pattern_02", "name": "High-Risk TLDs"},
        },
    }
    app_state = Normalizer.to_app_state(raw)
    assert app_state["src_ip"] == "192.168.1.45"
    assert app_state["action"] == "DENY"
    assert app_state["matched_pattern_id"] == "pattern_02"


def test_normalizer_field_map_indirection():
    """When FieldMap has custom dotted paths, those take priority over §5.2 defaults."""
    fm = FieldMap()
    fm.src_ip = "client_ip"  # flat custom field
    fm.timestamp = "@timestamp"
    hit = {
        "_id": "flat-id",
        "_source": {
            "client_ip": "10.0.0.9",
            "@timestamp": "2026-09-02T12:00:00.000Z",
            "source": {"host": "H1", "bytes": 100},
            "destination": {"ip": "1.2.3.4", "domain": "example.com"},
            "url": {"full": "http://example.com/"},
            "event": {"action": "allow", "duration": 3},
            "rule": {"id": "p1", "name": "n1"},
        },
    }
    app_state = Normalizer.to_app_state(hit, fm)
    assert app_state["src_ip"] == "10.0.0.9"
    assert app_state["src_host"] == "H1"
    assert app_state["domain"] == "example.com"


def test_normalizer_missing_fields():
    """Missing rule/action surface as None/'' instead of raising; id is kept."""
    app_state = Normalizer.to_app_state({"_id": "empty", "_source": {}})
    assert app_state["id"] == "empty"
    assert app_state["action"] == ""
    assert app_state["matched_pattern_id"] is None
