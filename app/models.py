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


class BlacklistEntryCreate(BaseModel):
    value: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="manual", pattern="^(manual|finding|redirect)$")
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


class JaillistEntryCreate(BaseModel):
    value: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="manual", pattern="^(manual|finding|upstream)$")
    finding_id: int | None = None


class JaillistBulkAdd(BaseModel):
    """Bulk-add model: raw values are normalized like single adds; each line
    becomes its own entry (single client IP)."""

    values: list[str] = Field(..., min_length=1, max_length=500)


class JaillistBulkDelete(BaseModel):
    """Bulk-delete model: values to remove (flat list — no kind)."""

    values: list[str] = Field(..., min_length=1, max_length=500)


class JaillistEntryResponse(BaseModel):
    id: int
    value: str
    source: str
    finding_id: int | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class TriageVerdictCreate(BaseModel):
    """A human decision on a flagged subject (the verdict ledger).

    ``verdict`` and ``subject_kind`` are validated against their allowed
    values here AND in the service AND by the DB CHECK — defense in depth.
    ``rule_ids`` records which rules the operator saw fire; ``category`` and
    ``note`` are operator free text and never an enum.
    """

    subject_kind: str = Field(..., pattern="^(destination|source)$")
    subject: str = Field(..., min_length=1, max_length=500)
    verdict: str = Field(
        ...,
        pattern="^(HARMFUL_DESTINATION|HARMFUL_SOURCE|NOT_HARMFUL|INCONCLUSIVE)$",
    )
    finding_id: int | None = None
    url: str = Field(default="", max_length=2000)
    category: str = Field(default="", max_length=500)
    note: str = Field(default="", max_length=2000)
    rule_ids: list[str] | None = None
    evidence_summary: dict | None = None
    supersedes_id: int | None = None


class RedirectTrackCreate(BaseModel):
    url: str = Field(..., min_length=1, max_length=500)
    source: str = Field(default="manual", pattern="^(manual|finding)$")


class RedirectCheckRequest(BaseModel):
    url: str | None = Field(None, max_length=500)
    urls: list[str] | None = Field(None, max_length=100)

    model_config = {"extra": "forbid"}


class LogBulkDelete(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=500)
