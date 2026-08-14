from celery import Celery

from app.core.settings import get_settings

settings = get_settings()

celery_app = Celery(
    "aiccountant",
    broker=settings.redis_url,
    backend=settings.redis_url,
)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    beat_schedule={
        # скан правил каждые 15 минут; гранулярность расписания — дневная,
        # частый тик лишь уменьшает задержку срабатывания
        "scan-due-recurring": {"task": "recurring.scan_due", "schedule": 900.0},
        # тик чаще порога зависания (STUCK_AFTER = 15 минут в app.imports.tasks),
        # чтобы запись не висела в processing надолго после реального зависания
        "reap-stuck-imports": {"task": "imports.reap_stuck", "schedule": 600.0},
    },
)
# задачи регистрируются из app/recurring/tasks.py, app/ledger/tasks.py и app/imports/tasks.py
celery_app.autodiscover_tasks(["app.recurring", "app.ledger", "app.imports"])

# Процесс воркера не импортирует app.main (в отличие от API), поэтому ORM-модели
# других модулей надо зарегистрировать явно — иначе SQLAlchemy не резолвит FK
# recurring → workspaces/users/accounts/categories/transactions (как в alembic/env.py).
from app.identity import models as _identity_models  # noqa: E402,F401
from app.imports import models as _imports_models  # noqa: E402,F401
from app.ledger import models as _ledger_models  # noqa: E402,F401
from app.recurring import models as _recurring_models  # noqa: E402,F401
