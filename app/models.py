from datetime import datetime

from pydantic import BaseModel, Field


class UrlPatternBase(BaseModel):
    pattern: str = Field(..., min_length=1, max_length=500)
    pattern_type: str = Field(default="block", pattern="^(block|whitelist)$")


class UrlPatternCreate(UrlPatternBase):
    pass


class UrlPatternUpdate(BaseModel):
    pattern: str | None = Field(None, min_length=1, max_length=500)
    pattern_type: str | None = Field(None, pattern="^(block|whitelist)$")


class UrlPatternResponse(UrlPatternBase):
    id: int
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class UrlWhitelistBase(BaseModel):
    pattern: str = Field(..., min_length=1, max_length=500)


class UrlWhitelistCreate(UrlWhitelistBase):
    pass


class UrlWhitelistUpdate(BaseModel):
    pattern: str | None = Field(None, min_length=1, max_length=500)


class UrlWhitelistResponse(UrlWhitelistBase):
    id: int
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class PatternBulkImport(BaseModel):
    patterns: list[str] = Field(..., min_length=1, max_length=1000)
    pattern_type: str = Field(default="block", pattern="^(block|whitelist)$")


class PatternSimulateRequest(BaseModel):
    """Body for the Live Kibana pattern simulation (spec §3.3).

    ``pattern`` may contain wildcards (``*``/``?`` — matched via
    ``fnmatch``) or full regex syntax (fallback ``re.search``).
    ``timeRange`` is a UI label such as ``"24h"`` / ``"7d"``; it is
    translated to minutes server-side (defaults to 1440 = 24h).
    """

    pattern: str = Field(..., min_length=1, max_length=500)
    timeRange: str = Field(default="24h", max_length=32)  # noqa: N815 — interface uses camelCase


class BlacklistEntryCreate(BaseModel):
    value: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="manual", pattern="^(manual|finding)$")
    finding_id: int | None = None


class BlacklistBulkAdd(BaseModel):
    """Bulk-add model: raw values are normalized like single adds; each line
    becomes its own entry (bare FQDN / IPv4)."""

    values: list[str] = Field(..., min_length=1, max_length=500)


class BlacklistEntryRef(BaseModel):
    """An existing entry identified by its stored kind + value (both are
    normalized — the frontend sends back what the list endpoint returned)."""

    kind: str = Field(..., pattern="^(url|ip)$")
    value: str = Field(..., min_length=1, max_length=500)


class BlacklistBulkDelete(BaseModel):
    """Bulk-delete model: entries to remove, keyed by kind+value."""

    entries: list[BlacklistEntryRef] = Field(..., min_length=1, max_length=500)


class BlacklistEntryResponse(BaseModel):
    id: int
    kind: str
    value: str
    source: str
    finding_id: int | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class RedirectTrackCreate(BaseModel):
    url: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="manual", pattern="^(manual|finding)$")


class RedirectCheckRequest(BaseModel):
    url: str | None = Field(None, max_length=500)
    urls: list[str] | None = Field(None, max_length=100)

    model_config = {"extra": "forbid"}


class LogBulkDelete(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
