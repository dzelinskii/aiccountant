import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

# кто входит: браузер держит сессию в HttpOnly-cookie, приложение хранит её само
# в хранилище ОС и потому получает токен в ответе
Client = Literal["browser", "app"]


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    client: Client = "browser"


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    client: Client = "browser"


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    # только для client="app"; браузеру токен в теле не отдаётся — ему хватает
    # cookie, недоступной скриптам страницы
    session_token: str | None = None


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    role: str


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    workspaces: list[WorkspaceOut]


class MemberIn(BaseModel):
    email: EmailStr


class ApiTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ApiTokenOut(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    last_used_at: datetime | None


class ApiTokenCreated(ApiTokenOut):
    # единственное место, где токен виден целиком
    token: str
