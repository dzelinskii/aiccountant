import json
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.client import LLMClient
from app.ledger import repository
from app.ledger.models import Category

logger = structlog.get_logger()

SYSTEM_PROMPT = (
    "Ты помощник по учёту личных финансов. По описанию операции выбери ОДНУ "
    "категорию строго из предложенного списка. Если ни одна не подходит — верни null. "
    'Ответ только JSON: {"category": <имя из списка или null>, "confidence": <число 0..1>}.'
)


def kind_for_amount(amount: Decimal) -> str:
    return "expense" if amount < 0 else "income"


def choose_candidates(categories: list[Category], amount: Decimal) -> list[Category]:
    kind = kind_for_amount(amount)
    return [cat for cat in categories if cat.kind == kind]


def build_user_prompt(
    description: str, candidate_names: list[str], examples: list[tuple[str, str]]
) -> str:
    parts = [f"Категории: {', '.join(candidate_names)}."]
    if examples:
        sample = "; ".join(f"«{m}» → {n}" for m, n in examples)
        parts.append(f"Примеры прошлых решений: {sample}.")
    parts.append(f"Описание операции: «{description}».")
    return "\n".join(parts)


def parse_answer(raw: str, candidate_names: set[str]) -> tuple[str | None, Decimal]:
    """Разобрать JSON-ответ модели: валидное имя из кандидатов + уверенность 0..1.
    Любой сбой разбора — «нет категории», не падаем."""
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None, Decimal(0)
    if not isinstance(data, dict):
        return None, Decimal(0)
    name = data.get("category")
    # имя от модели может быть чем угодно (list/dict/число) — членство в set проверяем
    # только для строк, иначе «нет категории»
    if not isinstance(name, str) or name not in candidate_names:
        name = None
    try:
        confidence = Decimal(str(data.get("confidence", 0))).quantize(Decimal("0.001"))
    except (InvalidOperation, TypeError, ValueError):
        confidence = Decimal(0)
    # нечисловые/бесконечные значения (например "NaN") в min/max бросают InvalidOperation
    if not confidence.is_finite():
        confidence = Decimal(0)
    confidence = max(Decimal(0), min(Decimal(1), confidence))
    return name, confidence


@dataclass
class Decision:
    kind: str  # 'apply' | 'suggest' | 'none'
    category_id: uuid.UUID | None
    confidence: Decimal


def decide(
    name: str | None,
    confidence: Decimal,
    threshold: Decimal,
    by_name: dict[str, uuid.UUID],
) -> Decision:
    if name is None:
        return Decision("none", None, confidence)
    category_id = by_name[name]
    if confidence >= threshold:
        return Decision("apply", category_id, confidence)
    return Decision("suggest", category_id, confidence)


async def classify_one(
    llm: LLMClient,
    description: str,
    candidates: list[Category],
    examples: list[tuple[str, str]],
) -> tuple[str | None, Decimal]:
    names = [cat.name for cat in candidates]
    raw = await llm.complete_json(
        system=SYSTEM_PROMPT,
        user=build_user_prompt(description, names, examples),
    )
    return parse_answer(raw, set(names))


async def categorize_uncategorized(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    llm: LLMClient,
    *,
    threshold: Decimal,
    fewshot_limit: int,
) -> int:
    """Пройти по некатегоризированным операциям workspace и применить решение
    классификатора (авто/подсказка). Возвращает число обработанных."""
    categories = await repository.list_categories(db, workspace_id)
    transactions = await repository.list_uncategorized(db, workspace_id)
    processed = 0
    for txn in transactions:
        candidates = choose_candidates(categories, txn.amount)
        if not candidates:
            continue
        kind = kind_for_amount(txn.amount)
        examples = await repository.recent_confirmed_pairs(db, workspace_id, kind, fewshot_limit)
        try:
            name, confidence = await classify_one(llm, txn.merchant or "", candidates, examples)
        except Exception:
            # провайдер недоступен/ошибка — операция остаётся без категории, не падаем
            logger.warning("categorize_failed", transaction_id=str(txn.id))
            continue
        by_name = {cat.name: cat.id for cat in candidates}
        decision = decide(name, confidence, threshold, by_name)
        txn.category_confidence = decision.confidence
        if decision.kind == "apply":
            txn.category_id = decision.category_id
            txn.category_confirmed = False
        elif decision.kind == "suggest":
            txn.suggested_category_id = decision.category_id
        logger.info("categorized", transaction_id=str(txn.id), decision=decision.kind)
        processed += 1
    await db.commit()
    return processed
