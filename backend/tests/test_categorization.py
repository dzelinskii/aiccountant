import json
import uuid
from decimal import Decimal

from app.ledger import categorization as c
from app.ledger.models import Category


def _cat(name: str, kind: str) -> Category:
    cat = Category(name=name, kind=kind)
    cat.id = uuid.uuid4()
    return cat


def test_choose_candidates_filters_by_sign() -> None:
    cats = [_cat("Еда", "expense"), _cat("Зарплата", "income")]
    assert [x.name for x in c.choose_candidates(cats, Decimal("-5"))] == ["Еда"]
    assert [x.name for x in c.choose_candidates(cats, Decimal("5"))] == ["Зарплата"]


def test_parse_answer_valid_name_and_confidence() -> None:
    raw = json.dumps({"category": "Еда", "confidence": 0.95})
    name, conf = c.parse_answer(raw, {"Еда", "Транспорт"})
    assert name == "Еда"
    assert conf == Decimal("0.950")


def test_parse_answer_unknown_name_becomes_none() -> None:
    raw = json.dumps({"category": "Криптовалюта", "confidence": 0.99})
    name, conf = c.parse_answer(raw, {"Еда"})
    assert name is None


def test_parse_answer_broken_json_is_none_zero() -> None:
    name, conf = c.parse_answer("не json", {"Еда"})
    assert name is None
    assert conf == Decimal("0")


def test_parse_answer_non_scalar_category_is_none() -> None:
    raw = json.dumps({"category": [1, 2], "confidence": 0.9})
    name, _ = c.parse_answer(raw, {"Еда"})
    assert name is None


def test_parse_answer_nan_confidence_is_zero() -> None:
    raw = json.dumps({"category": "Еда", "confidence": "NaN"})
    name, conf = c.parse_answer(raw, {"Еда"})
    assert name == "Еда"
    assert conf == Decimal("0")


def test_parse_answer_confidence_clamped() -> None:
    _, conf = c.parse_answer(json.dumps({"category": "Еда", "confidence": 5}), {"Еда"})
    assert conf == Decimal("1.000")


def test_decide_apply_above_threshold() -> None:
    by_name = {"Еда": uuid.uuid4()}
    d = c.decide("Еда", Decimal("0.9"), Decimal("0.8"), by_name)
    assert d.kind == "apply"
    assert d.category_id == by_name["Еда"]


def test_decide_suggest_below_threshold() -> None:
    by_name = {"Еда": uuid.uuid4()}
    d = c.decide("Еда", Decimal("0.5"), Decimal("0.8"), by_name)
    assert d.kind == "suggest"
    assert d.category_id == by_name["Еда"]


def test_decide_none_when_no_name() -> None:
    d = c.decide(None, Decimal("0"), Decimal("0.8"), {})
    assert d.kind == "none"
    assert d.category_id is None
