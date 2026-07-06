import uuid

from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: uuid.UUID
    email: str


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
