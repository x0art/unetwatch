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
    source: str = Field(default="manual", pattern="^(manual|finding)$")
    finding_id: int | None = None


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
