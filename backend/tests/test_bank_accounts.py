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
    # Каждый кодовый имя принимается
    for code in BANK_CODES:
        assert re.search(BANK_CODE_PATTERN, code), f"Кода {code} должны принять"

    # Похожие, но чужие строки отвергаются
    invalid_codes = ["vtb", "vtbank", "sber2", "tbank sber", ""]
    for invalid in invalid_codes:
        assert not re.search(BANK_CODE_PATTERN, invalid), (
            f"Чужой код {invalid!r} не должен быть принят"
        )
