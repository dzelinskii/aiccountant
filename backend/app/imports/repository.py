from sqlalchemy.ext.asyncio import AsyncSession

from app.imports.models import Import


def add_import(db: AsyncSession, imp: Import) -> None:
    db.add(imp)
