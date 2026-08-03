"""Shared session token store for auth flow."""
from time import time

_session_tokens: dict[str, float] = {}
TOKEN_TTL = 86400  # 24 hours


def add_token(token: str) -> None:
    _session_tokens[token] = time() + TOKEN_TTL


def is_valid_token(token: str) -> bool:
    exp = _session_tokens.get(token)
    if exp is None:
        return False
    if time() > exp:
        _session_tokens.pop(token, None)
        return False
    return True
