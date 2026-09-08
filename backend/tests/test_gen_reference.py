import os
import re
import subprocess
import sys
from pathlib import Path

from scripts.gen_reference import render_all

BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_generator_is_deterministic() -> None:
    """Недетерминированный вывод роняет сверку в CI на пустом месте, и первое,
    чему научатся, — её игнорировать."""
    assert render_all() == render_all()


def test_schema_covers_known_tables() -> None:
    schema = render_all()["schema.md"]
    for table in ("transactions", "categories", "accounts", "imports", "api_tokens"):
        assert table in schema


def test_schema_marks_nullable_and_defaults() -> None:
    """Обязательность и умолчания — то, ради чего в схему и смотрят: на них
    держатся обещания вроде «счета до этой миграции продолжают работать»."""
    schema = render_all()["schema.md"]
    assert "hint" in schema
    assert "balance_adjustment" in schema


def test_schema_names_types_as_postgres_has_them() -> None:
    """Обобщённый рендер SQLAlchemy зовёт uuid «CHAR(32)», а timestamptz —
    «DATETIME». Читатель поверил бы и пошёл искать несуществующие колонки."""
    schema = render_all()["schema.md"]
    assert "UUID" in schema
    assert "TIMESTAMP WITH TIME ZONE" in schema
    assert "CHAR(32)" not in schema


def test_schema_does_not_depend_on_who_imported_first() -> None:
    """Таблицы попадают в metadata импортом моделей, а в общем прогоне их успевает
    импортировать conftest — и пропажу импортов в генераторе ни один тест в этом
    процессе не заметил бы. Порядок таблиц тоже не должен зависеть от того, кто
    вошёл первым: иначе сверка в CI падает на перестановках. Отдельный процесс с
    намеренно другим входом проверяет и то, и другое."""
    code = (
        "import app.recurring.models;"
        "from scripts.gen_reference import render_schema;"
        "print(render_schema())"
    )
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        check=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    assert result.stdout.replace("\r\n", "\n").strip() == render_all()["schema.md"].strip()


def test_api_covers_known_endpoints() -> None:
    api = render_all()["api.md"]
    assert "/api/dashboard" in api
    assert "/api/imports/{import_id}/commit" in api
    assert "POST" in api


def test_api_lists_paths_in_alphabetical_order() -> None:
    """Порядок задаёт сортировка, а не порядок регистрации роутеров: иначе новый
    роутер посреди main.py перетасует весь файл, и сверка в CI утонет в шуме."""
    paths = re.findall(r"^- `[A-Z]+ (\S+)`", render_all()["api.md"], flags=re.MULTILINE)
    assert paths == sorted(paths)


def test_api_says_it_is_unversioned() -> None:
    """Чтобы агент не искал /v1 и не выдумал его."""
    assert "не версионирован" in render_all()["api.md"]


def test_vocabularies_cover_operation_kinds() -> None:
    from app.core.operation_kinds import OPERATION_KINDS

    vocab = render_all()["vocabularies.md"]
    for kind in OPERATION_KINDS:
        assert kind in vocab


def test_vocabularies_mark_what_is_out_of_stats() -> None:
    """Какие виды не входят в статистику — самый частый вопрос к этому словарю."""
    vocab = render_all()["vocabularies.md"]
    assert "transfer_self" in vocab
    assert "не входит в статистику" in vocab


def test_vocabularies_put_every_kind_on_the_right_side() -> None:
    """Проверка выше довольствуется тем, что слова «не входит в статистику» где-то
    есть. Соврав про конкретный вид, словарь остался бы зелёным — а именно за этим
    ответом в него и приходят."""
    from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS

    vocab = render_all()["vocabularies.md"]
    for kind in OPERATION_KINDS:
        expected = "не входит" if kind in NON_SPENDING_KINDS else "входит"
        assert f"- `{kind}` — {expected} в статистику" in vocab


def test_vocabularies_cover_all_category_hints() -> None:
    from app.core.category_hints import CATEGORY_HINTS

    vocab = render_all()["vocabularies.md"]
    for hint in CATEGORY_HINTS:
        assert hint in vocab


def test_boundaries_cover_all_contracts() -> None:
    """Контрактов import-linter семь; выпади один из документа — читатель решит,
    что границы там нет."""
    boundaries = render_all()["module-boundaries.md"]
    assert boundaries.count("### ") == 7


def test_boundaries_mention_allowed_exceptions() -> None:
    """Контракт ловит и косвенные пути, поэтому у половины из них есть выписанные
    исключения. Без них барьер выглядит сплошным, и читатель сделает вывод, что
    пути из ledger в recurring нет вовсе."""
    boundaries = render_all()["module-boundaries.md"]
    assert "app.ledger.tasks -> app.core.celery_app" in boundaries
    assert "app.recurring.service -> app.ledger.service" in boundaries


def test_generated_files_warn_against_hand_editing() -> None:
    for text in render_all().values():
        assert "не правьте руками" in text
