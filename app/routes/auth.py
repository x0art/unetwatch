from hmac import compare_digest
from secrets import token_hex

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.auth_store import TOKEN_TTL, add_token
from app.config import get_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    token: str
    expires_in: int


@router.post("/login")
async def login(data: LoginRequest):
    settings = get_settings()
    if not (
        compare_digest(data.username.encode(), settings.admin_user.encode())
        and compare_digest(data.password.encode(), settings.admin_pass.encode())
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    token = token_hex(32)
    add_token(token)
    return LoginResponse(token=token, expires_in=TOKEN_TTL)
