from app.core.category_hints import CATEGORY_HINTS, HINT_DEFAULTS, HintTarget
from app.ledger.repository import DEFAULT_CATEGORIES


def test_every_hint_has_a_target() -> None:
    """Раскладка неполна — подсказка молча перестанет срабатывать; лишняя
    запись — опечатка в имени подсказки."""
    assert set(HINT_DEFAULTS) == set(CATEGORY_HINTS)


def test_target_carries_parent_name_and_direction() -> None:
    assert HINT_DEFAULTS["groceries"] == HintTarget("Еда", "Продукты", "expense")


def test_salary_lands_in_parent_without_subcategory() -> None:
    """Дробить «Зарплату» не на что, и лишний уровень там был бы шумом."""
    assert HINT_DEFAULTS["salary"] == HintTarget("Зарплата", None, "income")


def test_parents_come_from_default_tree() -> None:
    """Родителя, которого нет в дефолтном наборе, подсказка не найдёт никогда."""
    known = {name for name, _ in DEFAULT_CATEGORIES}
    assert {t.parent for t in HINT_DEFAULTS.values()} - known == set()


def test_hint_direction_matches_parent_direction() -> None:
    """Доходная подсказка под расходным родителем не сработает ни разу:
    знак суммы не совпадёт."""
    kind_of = dict(DEFAULT_CATEGORIES)
    assert [h for h, t in HINT_DEFAULTS.items() if kind_of[t.parent] != t.kind] == []


def test_subcategory_names_are_unique_within_parent() -> None:
    """Две подсказки с одним именем под одним родителем сядут в одну категорию
    и будут перетирать отметку друг друга на каждой операции."""
    pairs = [(t.parent, t.sub) for t in HINT_DEFAULTS.values()]
    assert len(pairs) == len(set(pairs))


def test_only_salary_lands_in_the_parent_itself() -> None:
    """`sub is None` помечает подсказкой саму категорию верхнего уровня.
    Случайный None увёл бы туда чужую подсказку и занял бы родителя навсегда."""
    assert [h for h, t in HINT_DEFAULTS.items() if t.sub is None] == ["salary"]
