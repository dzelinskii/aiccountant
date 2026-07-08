import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.identity.deps import require_workspace_member
from app.identity.models import Membership, User, Workspace


async def test_require_workspace_member_binds_log_context(db_session: AsyncSession) -> None:
    # зависимость отвечает за привязку идентификаторов в structlog-contextvars,
    # чтобы доменные логи запроса несли workspace_id/user_id (без PII и сумм).
    # проверяем её напрямую: middleware лишь чистит контекст на входе запроса.
    user = User(email="ctx@example.com", password_hash="x")
    workspace = Workspace(name="Домохозяйство", type="personal")
    db_session.add_all([user, workspace])
    await db_session.flush()
    db_session.add(Membership(user_id=user.id, workspace_id=workspace.id, role="owner"))
    await db_session.flush()

    structlog.contextvars.clear_contextvars()
    returned = await require_workspace_member(workspace.id, user, db_session)

    assert returned is user
    bound = structlog.contextvars.get_contextvars()
    assert bound["workspace_id"] == str(workspace.id)
    assert bound["user_id"] == str(user.id)
