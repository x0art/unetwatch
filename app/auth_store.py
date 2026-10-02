"""Shared session token store for auth flow."""
from time import time

_session_tokens: dict[str, float] = {}
TOKEN_TTL = 86400  # 24 hours


def _sweep_expired(now: float) -> None:
    """Drop every expired token so the store cannot grow without bound.

    Tokens are only otherwise removed if the *same* token is re-checked after
    it expires, which never happens for the common case (a login whose token
    is simply abandoned). Sweeping on every add/lookup keeps the store bounded
    by the number of *currently valid* sessions.
    """
    for token, exp in list(_session_tokens.items()):
        if now > exp:
            _session_tokens.pop(token, None)


def add_token(token: str) -> None:
    now = time()
    _sweep_expired(now)
    _session_tokens[token] = now + TOKEN_TTL


def is_valid_token(token: str) -> bool:
    now = time()
    _sweep_expired(now)
    exp = _session_tokens.get(token)
    if exp is None:
        return False
    if now > exp:
        _session_tokens.pop(token, None)
        return False
    return True
