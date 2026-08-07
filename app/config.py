from functools import lru_cache
from secrets import compare_digest

from fastapi import Depends, HTTPException, status
from fastapi.security import APIKeyHeader, HTTPBasic, HTTPBasicCredentials
from pydantic_settings import BaseSettings

security_scheme = APIKeyHeader(name="X-API-Key", auto_error=False)
basic_scheme = HTTPBasic(auto_error=False)


class Settings(BaseSettings):
    elastic_host: str = "http://localhost:9200"
    elastic_index: str = "logstash-proxy-*"
    elastic_user: str = "elastic"
    elastic_pass: str = "changeme"
    webhook_url: str = "https://n8n.example.com/webhook/your-webhook-id"
    poll_interval_minutes: int = 10
    es_query_size: int = 5000
    redirect_check_interval_minutes: int = 60
    redirect_timeout_seconds: int = 10
    # Monitor log audit trail bounds: prune rows older than this many days,
    # and never keep more than this many rows (newest wins).
    log_retention_days: int = 30
    log_max_rows: int = 1000
    database_url: str = "sqlite:///./elk_monitoring.db"
    api_key: str = ""
    admin_user: str = "admin"
    admin_pass: str = "changeme"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()


async def verify_admin(
    credentials: HTTPBasicCredentials | None = Depends(basic_scheme),
    api_key: str | None = Depends(security_scheme),
) -> None:
    """Require valid credentials (Basic Auth, X-API-Key, or session token)."""
    settings = get_settings()

    # 1. Check X-API-Key header against configured API key
    if api_key and settings.api_key:
        if compare_digest(api_key, settings.api_key):
            return

    # 2. Check X-API-Key header against session token store
    if api_key:
        from app.auth_store import is_valid_token

        if is_valid_token(api_key):
            return

    # 3. Check Basic Auth against configured admin credentials
    if credentials is not None:
        if (
            compare_digest(credentials.username, settings.admin_user)
            and compare_digest(credentials.password, settings.admin_pass)
        ):
            return

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid API key or credentials",
        headers={"WWW-Authenticate": "Basic"},
    )
