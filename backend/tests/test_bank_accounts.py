import re

from app.core.banks import BANK_CODE_PATTERN, BANK_CODES, BANKS


def test_bank_code_has_human_name() -> None:
    """Код банка живёт в коде, название — рядом с ним: два списка в разных
    местах разъехались бы, и фронт показал бы не тот банк."""
    assert BANKS["alfa"] == "Альфа-Банк"
    assert set(BANK_CODES) == {"tbank", "sber", "alfa"}


def test_bank_code_pattern_anchors() -> None:
    """Шаблон кода банка должен иметь якоря — иначе Pydantic проверяет поиском,
    и vtbank, sber2, tbank_unknown будут приняты за знакомые. Якоря гарантируют,
    что совпадает вся строка целиком, а не её часть: это единственное, что мешает
    незнакомому коду молча записаться в базу."""
    for code in BANK_CODES:
        assert re.search(BANK_CODE_PATTERN, code), f"знакомый код {code} обязан проходить"

    # похожие, но чужие: без якорей каждая из этих строк прошла бы по подстроке
    for alien in ("vtb", "vtbank", "sber2", "tbank sber", ""):
        assert not re.search(BANK_CODE_PATTERN, alien), f"чужой код {alien!r} не должен проходить"
