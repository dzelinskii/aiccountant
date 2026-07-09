import json
from pathlib import Path

from app.ledger.repository import DEFAULT_CATEGORIES

EVAL_PATH = Path(__file__).parent / "data" / "categorize_eval.json"
_NAMES = {name for name, _ in DEFAULT_CATEGORIES}
_KIND_BY_NAME = {name: kind for name, kind in DEFAULT_CATEGORIES}


def test_eval_dataset_wellformed() -> None:
    data = json.loads(EVAL_PATH.read_text(encoding="utf-8"))
    assert len(data) >= 10
    for row in data:
        assert set(row) == {"description", "sign", "expected"}
        assert row["sign"] in {"expense", "income"}
        assert row["expected"] in _NAMES, f"неизвестная категория: {row['expected']}"
        # ожидаемая категория должна соответствовать знаку операции
        expected_kind = "expense" if row["sign"] == "expense" else "income"
        assert _KIND_BY_NAME[row["expected"]] == expected_kind
