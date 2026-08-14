import uuid
from datetime import date
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.imports import service
from app.imports.models import Import
from app.imports.parser import ParsedOperation, ParsedStatement, StatementParseError
from tests.fixtures import fixed_parse
from tests.test_import_async_service import SAMPLE

ALICE = {"email": "alice@example.com", "password": "password123"}
BOB = {"email": "bob@example.com", "password": "password123"}

FILES = {"file": ("statement.pdf", b"%PDF-dummy", "application/pdf")}

# две идентичные операции одного дня (в выписке бывают реальные повторы —
# банк не даёт id операции): не должны схлопнуться в одну через _external_ids
DUP_STATEMENT = ParsedStatement(
    operations=[
        ParsedOperation(
            occurred_at=date(2026, 6, 29),
            amount=Decimal("-29600.00"),
            currency="RUB",
            description="Внутренний перевод на договор 9358",
        ),
        ParsedOperation(
            occurred_at=date(2026, 6, 29),
            amount=Decimal("-29600.00"),
            currency="RUB",
            description="Внутренний перевод на договор 9358",
        ),
    ],
    total_income=None,
    total_expense=None,
)


async def _setup(client: AsyncClient, creds: dict[str, str]) -> tuple[str, str]:
    await client.post("/api/auth/register", json=creds)
    me = await client.get("/api/me")
    ws = str(me.json()["workspaces"][0]["id"])
    acc = (
        await client.post(
            "/api/accounts",
            params={"workspace_id": ws},
            json={"name": "Карта", "type": "card", "currency": "RUB"},
        )
    ).json()["id"]
    return ws, acc


async def test_start_import_returns_202_and_enqueues_parse(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    stub_parse_enqueue: list[uuid.UUID],
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)

    resp = await client.post(
        "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
    )

    assert resp.status_code == 202
    body = resp.json()
    assert body["status"] == "processing"
    assert uuid.UUID(body["import_id"]) in stub_parse_enqueue


async def test_full_flow_status_and_commit(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # разбор в бою асинхронный (LLM ходит по сети): брокер в тестах заглушен,
    # поэтому фоновую задачу здесь имитируем прямым вызовом service.run_parse
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)

    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()
    import_id = started["import_id"]

    await service.run_parse(
        db_session, uuid.UUID(import_id), parse=fixed_parse(SAMPLE, "tbank_statement")
    )

    status = (await client.get(f"/api/imports/{import_id}", params={"workspace_id": ws})).json()
    assert status["status"] == "ready"
    assert status["parser"] == "tbank_statement"
    assert status["preview"]["new_count"] == 2
    assert status["preview"]["duplicate_count"] == 0

    commit = await client.post(f"/api/imports/{import_id}/commit", params={"workspace_id": ws})
    assert commit.status_code == 200
    assert commit.json()["imported"] == 2

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 2


async def test_status_notfound_and_foreign_workspace_return_same_404(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # защищаемое свойство — РАВЕНСТВО: чужой импорт неотличим от несуществующего,
    # иначе расхождение кода/текста между ними выдало бы факт существования чужой записи
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()

    client.cookies.clear()
    ws_bob, _ = await _setup(client, BOB)

    foreign = await client.get(
        f"/api/imports/{started['import_id']}", params={"workspace_id": ws_bob}
    )
    missing = await client.get(f"/api/imports/{uuid.uuid4()}", params={"workspace_id": ws_bob})

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json()["detail"] == missing.json()["detail"]


async def test_commit_notfound_and_foreign_workspace_return_same_404(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()
    await service.run_parse(
        db_session,
        uuid.UUID(started["import_id"]),
        parse=fixed_parse(SAMPLE, "tbank_statement"),
    )

    client.cookies.clear()
    ws_bob, _ = await _setup(client, BOB)

    foreign = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws_bob}
    )
    missing = await client.post(
        f"/api/imports/{uuid.uuid4()}/commit", params={"workspace_id": ws_bob}
    )

    assert foreign.status_code == missing.status_code == 404
    assert foreign.json()["detail"] == missing.json()["detail"]


async def test_commit_while_still_processing_is_409(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()

    resp = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws}
    )
    assert resp.status_code == 409


async def test_commit_of_failed_import_is_409(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # фронт в поллинге должен различать "ещё разбирается" и "разбор провалился" —
    # оба не готовы к коммиту, поэтому 409 у обоих статусов, не только у processing
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()

    async def _boom(lines: list[str]) -> tuple[ParsedStatement, str]:
        raise StatementParseError("формат не распознан")

    await service.run_parse(db_session, uuid.UUID(started["import_id"]), parse=_boom)

    resp = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws}
    )
    assert resp.status_code == 409


async def test_identical_operations_in_one_parse_not_collapsed(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    started = (
        await client.post(
            "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
        )
    ).json()
    await service.run_parse(
        db_session,
        uuid.UUID(started["import_id"]),
        parse=fixed_parse(DUP_STATEMENT, "tbank_statement"),
    )

    status = (
        await client.get(f"/api/imports/{started['import_id']}", params={"workspace_id": ws})
    ).json()
    assert status["preview"]["new_count"] == 2
    assert status["preview"]["duplicate_count"] == 0

    commit = await client.post(
        f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws}
    )
    assert commit.json()["imported"] == 2

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 2


async def test_recommit_of_same_statement_via_new_import_is_deduped(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # тот же файл, загруженный как ОТДЕЛЬНЫЙ (второй) импорт — проверяет реальный
    # путь через existing_external_ids, а не короткое замыкание "completed" у
    # повторного коммита ТОГО ЖЕ import_id
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)

    async def _start_and_commit() -> dict[str, object]:
        started = (
            await client.post(
                "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
            )
        ).json()
        await service.run_parse(
            db_session,
            uuid.UUID(started["import_id"]),
            parse=fixed_parse(SAMPLE, "tbank_statement"),
        )
        resp = await client.post(
            f"/api/imports/{started['import_id']}/commit", params={"workspace_id": ws}
        )
        result: dict[str, object] = resp.json()
        return result

    first = await _start_and_commit()
    assert first["imported"] == 2
    assert first["duplicates"] == 0

    second = await _start_and_commit()
    assert second["imported"] == 0
    assert second["duplicates"] == 2

    txns = (await client.get("/api/transactions", params={"workspace_id": ws})).json()
    assert txns["total"] == 2  # повторный импорт не задвоил


async def test_wrong_content_type_rejected(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("statement.txt", b"hello", "text/plain")},
    )
    assert resp.status_code == 415


async def test_too_large_rejected(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.imports.router.MAX_UPLOAD_BYTES", 4)
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("statement.pdf", b"%PDF-too-big", "application/pdf")},
    )
    assert resp.status_code == 413


async def test_unknown_account_rejected(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    ws, _ = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": str(uuid.uuid4())},
        files=FILES,
    )
    assert resp.status_code == 404


async def test_foreign_account_rejected(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # тот же 404, что и для несуществующего счёта: реальный чужой account_id не
    # должен давать иной результат (иначе фильтр по workspace_id в account_exists
    # мог бы незаметно отвалиться, а тест со случайным UUID остался бы зелёным)
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])
    _ws_a, acc_a = await _setup(client, ALICE)
    client.cookies.clear()
    ws_b, _ = await _setup(client, BOB)

    resp = await client.post(
        "/api/imports", params={"workspace_id": ws_b, "account_id": acc_a}, files=FILES
    )
    assert resp.status_code == 404


async def test_unparsable_pdf_returns_422(client: AsyncClient) -> None:
    # реальный мусор вместо PDF (extract_lines НЕ подменяем) — проверяем настоящий
    # отказ pypdf, а не заглушку
    ws, acc = await _setup(client, ALICE)
    resp = await client.post(
        "/api/imports",
        params={"workspace_id": ws, "account_id": acc},
        files={"file": ("statement.pdf", b"not a pdf at all", "application/pdf")},
    )
    assert resp.status_code == 422


async def test_enqueue_failure_marks_import_failed_and_returns_503(
    client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.imports.router.extract_lines", lambda b: ["строка выписки"])

    def _broker_down(import_id: uuid.UUID) -> None:
        raise RuntimeError("broker unavailable")

    monkeypatch.setattr("app.imports.router.enqueue_parse", _broker_down)
    ws, acc = await _setup(client, ALICE)

    resp = await client.post(
        "/api/imports", params={"workspace_id": ws, "account_id": acc}, files=FILES
    )
    assert resp.status_code == 503

    # запись создана, но не осталась висеть в processing с текстом выписки (PII)
    imp = await db_session.scalar(select(Import).where(Import.workspace_id == uuid.UUID(ws)))
    assert imp is not None
    assert imp.status == "failed"
    assert imp.raw_text is None
