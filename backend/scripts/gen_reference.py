"""Генератор справочных фактов: схема, ручки, словари, границы модулей.

Всё это существует в коде ровно в одном месте. Написав то же руками, мы завели
бы второй источник истины — то есть ровно ту болезнь, которую справочник лечит.

Вывод обязан быть детерминированным: сверка в CI сравнивает его с закоммиченным,
и любая нестабильность (даты, порядок словаря) сделает её шумом, который
научатся игнорировать.

Запуск: cd backend && uv run python scripts/gen_reference.py
"""

import sys
import tomllib
from pathlib import Path
from typing import Any

from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import Dialect

BACKEND_DIR = Path(__file__).resolve().parent.parent

# Запуск файлом кладёт в sys.path каталог scripts, а не backend, и пакет `app`
# тогда не находится. Отсюда же и импорты приложения ниже исполняемой строки.
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.core.category_hints import CATEGORY_HINTS, HINT_DEFAULTS  # noqa: E402
from app.core.db import Base  # noqa: E402
from app.core.operation_kinds import NON_SPENDING_KINDS, OPERATION_KINDS  # noqa: E402

# импорт моделей ради регистрации таблиц в Base.metadata: без него схема выйдет пустой
from app.identity import models as _identity  # noqa: E402, F401
from app.imports import models as _imports  # noqa: E402, F401
from app.ledger import models as _ledger  # noqa: E402, F401
from app.ledger.repository import DEFAULT_CATEGORIES  # noqa: E402
from app.recurring import models as _recurring  # noqa: E402, F401

OUT_DIR = BACKEND_DIR.parent / "docs" / "reference" / "generated"
PYPROJECT = BACKEND_DIR / "pyproject.toml"

WARNING = (
    "<!-- Этот файл создан генератором, не правьте руками: "
    "правки затрёт следующая перегенерация, а CI её потребует. "
    "Источник — backend/scripts/gen_reference.py -->"
)

# Типы печатаем на диалекте Postgres — единственном, под которым проект живёт.
# Обобщённый рендер SQLAlchemy назвал бы uuid «CHAR(32)», а timestamptz —
# «DATETIME», и справочник врал бы о том, что лежит в базе.
# Конструктор диалекта в SQLAlchemy не типизирован, типизированной замены нет.
PG_DIALECT: Dialect = postgresql.dialect()  # type: ignore[no-untyped-call]


def _column_line(column: Any) -> str:
    parts = [f"`{column.name}`", f"`{column.type.compile(dialect=PG_DIALECT)}`"]
    parts.append("обязательна" if not column.nullable else "может быть пустой")
    if column.primary_key:
        parts.append("первичный ключ")
    for fk in sorted(column.foreign_keys, key=lambda f: str(f.target_fullname)):
        parts.append(f"→ `{fk.target_fullname}`")
    if column.server_default is not None:
        parts.append(f"по умолчанию `{column.server_default.arg}`")
    return " · ".join(parts)


def render_schema() -> str:
    lines = [WARNING, "", "# Схема базы данных", ""]
    for table in Base.metadata.sorted_tables:
        lines.append(f"## `{table.name}`")
        lines.append("")
        for column in table.columns:
            lines.append(f"- {_column_line(column)}")
        indexes = sorted(table.indexes, key=lambda i: i.name or "")
        if indexes:
            lines.append("")
            lines.append("Индексы:")
            for index in indexes:
                cols = ", ".join(f"`{c.name}`" for c in index.columns)
                kind = "уникальный" if index.unique else "обычный"
                lines.append(f"- `{index.name}` ({kind}): {cols}")
        lines.append("")
    return "\n".join(lines)


def _schema_ref_name(schema: dict[str, Any] | None) -> tuple[str, bool] | None:
    """Достаёт имя схемы из `$ref` вида `#/components/schemas/ParsedImportIn`
    вместе с признаком «это список».

    Pydantic заворачивает часть ссылок в `allOf`/`anyOf` (например, когда у
    поля есть описание) — тогда `$ref` лежит на уровень глубже, но ведёт к
    той же схеме, и её тоже стоит найти. У ручек-списков схема — не `$ref`,
    а `{"type": "array", "items": {"$ref": ...}}`: не разворачивая `items`,
    справочник решил бы, что схемы нет вовсе, хотя она есть — просто ответ
    не один объект, а список таких объектов.
    """
    if schema is None:
        return None
    ref = schema.get("$ref")
    if isinstance(ref, str):
        return ref.rsplit("/", 1)[-1], False
    if schema.get("type") == "array":
        items = schema.get("items")
        nested = _schema_ref_name(items) if isinstance(items, dict) else None
        if nested is not None:
            name, _ = nested
            return name, True
        return None
    for branch in (*schema.get("allOf", []), *schema.get("anyOf", [])):
        branch_result = _schema_ref_name(branch)
        if branch_result is not None:
            return branch_result
    return None


def _json_schema(container: dict[str, Any]) -> dict[str, Any] | None:
    content = container.get("content", {})
    body = content.get("application/json", {})
    result = body.get("schema")
    return result if isinstance(result, dict) else None


def _request_schema_name(operation: dict[str, Any]) -> tuple[str, bool] | None:
    request_body = operation.get("requestBody")
    if request_body is None:
        return None
    return _schema_ref_name(_json_schema(request_body))


# 202 наравне с 200 и 201: им отвечают ручки, ставящие работу в фоновую очередь
# (загрузка выписки, категоризация). Забудь мы этот код — справочник умолчал бы
# про их ответ, и читатель решил бы, что ручка не отвечает ничем
SUCCESS_CODES = ("200", "201", "202")


def _response_schema_name(operation: dict[str, Any]) -> tuple[str, bool] | None:
    responses = operation.get("responses", {})
    for code in SUCCESS_CODES:
        response = responses.get(code)
        if response is not None:
            return _schema_ref_name(_json_schema(response))
    return None


def _schema_label(name_and_is_list: tuple[str, bool]) -> str:
    name, is_list = name_and_is_list
    return f"списком `{name}`" if is_list else f"`{name}`"


def render_api() -> str:
    from app.main import app

    schema = app.openapi()
    lines = [
        WARNING,
        "",
        "# Ручки API",
        "",
        "API **не версионирован**: все пути живут под `/api`, префикса версии нет. "
        "Кроме них приложение отдаёт служебные `/docs`, `/redoc` и `/openapi.json` — "
        "в схему OpenAPI они не входят (`include_in_schema=False`), поэтому в этот "
        "список не попадают.",
        "",
    ]
    for path in sorted(schema.get("paths", {})):
        for method in sorted(schema["paths"][path]):
            operation = schema["paths"][path][method]
            # Автозаголовок FastAPI («List Accounts») не несёт смысла сверх пути
            # и метода. Полезнее назвать схемы запроса и ответа — по ним читатель
            # найдёт определение в коде. Схемы может не быть (например, у GET нет
            # тела запроса, а у 204-ответа — тела вовсе): тогда просто не пишем её,
            # а не подставляем пустое значение, которое выглядело бы как имя.
            parts = []
            request_schema = _request_schema_name(operation)
            if request_schema is not None:
                parts.append(f"принимает {_schema_label(request_schema)}")
            response_schema = _response_schema_name(operation)
            if response_schema is not None:
                parts.append(f"отвечает {_schema_label(response_schema)}")
            suffix = f" — {', '.join(parts)}" if parts else ""
            lines.append(f"- `{method.upper()} {path}`{suffix}")
    lines.append("")
    return "\n".join(lines)


def render_vocabularies() -> str:
    lines = [WARNING, "", "# Словари", "", "## Виды операций", ""]
    for kind in OPERATION_KINDS:
        note = "не входит в статистику" if kind in NON_SPENDING_KINDS else "входит в статистику"
        lines.append(f"- `{kind}` — {note}")
    lines.extend(["", "## Категории по умолчанию", ""])
    for name, kind in DEFAULT_CATEGORIES:
        lines.append(f"- {name} ({kind})")
    lines.extend(["", "## Подсказки о категории", ""])
    for hint in CATEGORY_HINTS:
        target = HINT_DEFAULTS[hint]
        where = target.parent if target.sub is None else f"{target.parent} / {target.sub}"
        lines.append(f"- `{hint}` → {where} ({target.kind})")
    lines.append("")
    return "\n".join(lines)


def render_boundaries() -> str:
    with PYPROJECT.open("rb") as handle:
        config = tomllib.load(handle)
    contracts = config["tool"]["importlinter"]["contracts"]
    lines = [
        WARNING,
        "",
        "# Границы модулей",
        "",
        "Проверяются import-linter при каждом прогоне CI; нарушение красит сборку.",
        "",
    ]
    for contract in contracts:
        lines.append(f"### {contract['name']}")
        lines.append("")
        sources = ", ".join(f"`{m}`" for m in contract.get("source_modules", []))
        forbidden = ", ".join(f"`{m}`" for m in contract.get("forbidden_modules", []))
        lines.append(f"- {sources} не импортируют {forbidden}")
        # Контракт запрещает и косвенные пути, а исключения из него разрешают
        # конкретные рёбра. Умолчав о них, справочник изобразил бы барьер
        # сплошным там, где он с оговорками.
        for ignored in contract.get("ignore_imports", []):
            lines.append(f"- исключение, разрешённое явно: `{ignored}`")
        lines.append("")
    return "\n".join(lines)


def render_all() -> dict[str, str]:
    return {
        "schema.md": render_schema(),
        "api.md": render_api(),
        "vocabularies.md": render_vocabularies(),
        "module-boundaries.md": render_boundaries(),
    }


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in render_all().items():
        (OUT_DIR / name).write_text(text, encoding="utf-8", newline="\n")
        print(f"записан {name}")


if __name__ == "__main__":
    main()
