from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    elastic_host: str = "http://localhost:9200"
    elastic_index: str = "logstash-proxy-*"
    elastic_user: str = "elastic"
    elastic_pass: str = "changeme"
    webhook_url: str = "https://n8n.example.com/webhook/your-webhook-id"
    poll_interval_minutes: int = 10
    es_query_size: int = 5000
    database_url: str = "sqlite:///./elk_monitoring.db"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
