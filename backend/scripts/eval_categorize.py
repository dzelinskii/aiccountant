"""Ручной прогон accuracy автокатегоризации против живого LLM-провайдера.

Требует настроенных LLM_BASE_URL/LLM_API_KEY/LLM_MODEL_CATEGORIZE в окружении.
В CI не запускается (нужен ключ и сеть); это инструмент для калибровки порога
и модели на реальных описаниях.

Запуск: uv run python scripts/eval_categorize.py
"""

import asyncio
import json
import uuid
from decimal import Decimal
from pathlib import Path

from app.ai.client import build_llm_client
from app.ledger.categorization import classify_one
from app.ledger.models import Category
from app.ledger.repository import DEFAULT_CATEGORIES

EVAL_PATH = Path(__file__).parent.parent / "tests" / "data" / "categorize_eval.json"


def _candidates(kind: str) -> list[Category]:
    result: list[Category] = []
    for name, cat_kind in DEFAULT_CATEGORIES:
        if cat_kind == kind:
            cat = Category(name=name, kind=kind)
            cat.id = uuid.uuid4()
            result.append(cat)
    return result


async def main() -> None:
    data = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    llm = build_llm_client()
    correct = 0
    for row in data:
        candidates = _candidates(row["sign"])
        name, confidence = await classify_one(llm, row["description"], candidates, [])
        ok = name == row["expected"]
        correct += int(ok)
        mark = "OK " if ok else "MISS"
        print(f"{mark} «{row['description']}» → {name} ({confidence}); ждали {row['expected']}")
    total = len(data)
    print(f"\nAccuracy: {correct}/{total} = {Decimal(correct) / Decimal(total):.2f}")


if __name__ == "__main__":
    asyncio.run(main())
