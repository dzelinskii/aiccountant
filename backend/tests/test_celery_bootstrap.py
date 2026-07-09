import subprocess
import sys


def test_worker_bootstrap_registers_all_models() -> None:
    # Процесс воркера импортирует app.core.celery_app, но НЕ app.main, поэтому
    # celery_app обязан сам зарегистрировать ORM-модели всех модулей — иначе
    # SQLAlchemy не резолвит FK recurring → workspaces/users/accounts/... уже в
    # рантайме воркера (NoReferencedTableError). Проверяем в отдельном процессе,
    # чтобы conftest (который тянет app.main) не наполнил metadata за нас.
    code = (
        "from app.core.celery_app import celery_app\n"
        "from app.core.db import Base\n"
        "need = {'workspaces', 'users', 'accounts', 'categories', 'transactions', "
        "'recurring_rules', 'recurring_occurrences'}\n"
        "have = set(Base.metadata.tables)\n"
        "assert need <= have, f'нет таблиц: {need - have}'\n"
        "assert celery_app.main == 'aiccountant'\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
