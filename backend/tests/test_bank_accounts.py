from app.core.banks import BANK_CODES, BANKS


def test_bank_code_has_human_name() -> None:
    """Код банка живёт в коде, название — рядом с ним: два списка в разных
    местах разъехались бы, и фронт показал бы не тот банк."""
    assert BANKS["alfa"] == "Альфа-Банк"
    assert set(BANK_CODES) == {"tbank", "sber", "alfa"}
