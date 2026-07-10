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
        # autodiscover_tasks по умолчанию ленивый (сработает в реальном воркере при
        # его старте); в тесте форсируем импорт модулей задач явно
        "celery_app.loader.import_default_modules()\n"
        "assert 'ledger.categorize_workspace' in celery_app.tasks\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
