from functools import lru_cache
from secrets import compare_digest

from fastapi import Depends, HTTPException, status
from fastapi.security import APIKeyHeader, HTTPBasic, HTTPBasicCredentials
from pydantic import model_validator
from pydantic_settings import BaseSettings

security_scheme = APIKeyHeader(name="X-API-Key", auto_error=False)
basic_scheme = HTTPBasic(auto_error=False)

WEAK_PASSWORDS = {"changeme", "admin", "password", "123456", "secret"}


class Settings(BaseSettings):
    app_env: str = "development"
    elastic_host: str = "http://localhost:9200"
    elastic_index: str = "logstash-proxy-*"
    elastic_user: str = "elastic"
    elastic_pass: str = "changeme"
    webhook_url: str = "https://n8n.example.com/webhook/your-webhook-id"
    msteams_webhook_url: str = ""
    # Base URL for generating clickable links in MS Teams alerts
    # (e.g. "https://unetwatch.example.com"). Falls back to empty string.
    base_url: str = ""
    poll_interval_minutes: int = 10
    es_query_size: int = 5000
    redirect_check_interval_minutes: int = 60
    redirect_timeout_seconds: int = 10
    # Monitor log audit trail bounds: prune rows older than this many days,
    # and never keep more than this many rows (newest wins).
    log_retention_days: int = 30
    log_max_rows: int = 1000
    database_url: str = "sqlite:///./unetwatch.db"
    # Directory holding the static blacklist feed files (urls.txt / ips.txt).
    # Files here are regenerated from the DB on startup and after every change,
    # and are served as real files at /api/blacklist/{urls,ips}.txt.
    # Relative to the working directory: resolves to ./data locally and to
    # /app/data in the container (the volume mounted in docker-compose.yml).
    blacklist_dir: str = "./data"
    api_key: str = ""
    admin_user: str = "admin"
    admin_pass: str = "changeme"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Kibana connection bootstrap defaults (spec §3.5). These are the
    # .env-overridable fallbacks; the admin UI edits the live values via
    # GET/PUT /api/settings/kibana (persisted in the `settings` table).
    kibana_host_url: str = "https://kibana-internal.corp.net:5601"
    kibana_index_pattern: str = "logstash-network-traffic-*"
    kibana_auth_type: str = "apiKey"
    kibana_api_key: str = ""

    # Risk scoring weights (env: RISK_WEIGHT_<CLASS> or risk_weight_<class> in .env)
    # Default 1.0 per class if not specified.
    risk_weight_malware: float | None = None
    risk_weight_phishing: float | None = None
    risk_weight_c2: float | None = None
    risk_weight_exploit: float | None = None
    risk_weight_suspicious: float | None = None

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    @model_validator(mode="after")
    def _validate_production(self):
        """Fail fast in production: refuse weak/default credentials and
        require an API key and a configured Elasticsearch endpoint."""
        if self.app_env != "production":
            return self

        if not self.admin_pass or self.admin_pass.lower() in WEAK_PASSWORDS:
            raise ValueError(
                "APP_ENV=production requires a strong ADMIN_PASS "
                "(not changeme/admin/password/123456/secret)."
            )
        if not self.api_key:
            raise ValueError(
                "APP_ENV=production requires a non-empty API_KEY for programmatic access."
            )
        if not self.elastic_host or self.elastic_host.startswith("http://localhost"):
            raise ValueError(
                "APP_ENV=production requires an explicit ELASTIC_HOST (not localhost)."
            )
        if not self.elastic_index:
            raise ValueError("APP_ENV=production requires a non-empty ELASTIC_INDEX.")
        return self


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
