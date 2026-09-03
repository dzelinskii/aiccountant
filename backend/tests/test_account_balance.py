from decimal import Decimal

from app.ledger.balance import adjustment_for, visible_balance


def test_reported_balance_wins() -> None:
    # источник сообщил остаток — он и показывается, поправка не участвует
    assert visible_balance(Decimal("100.00"), Decimal("999.00"), Decimal("-50.00")) == Decimal(
        "100.00"
    )


def test_without_reported_sum_and_adjustment() -> None:
    assert visible_balance(None, Decimal("5000.00"), Decimal("-200.00")) == Decimal("4800.00")


def test_without_reported_and_without_adjustment() -> None:
    # поведение до этой задачи: остаток равен сумме операций
    assert visible_balance(None, Decimal(0), Decimal("-122515.28")) == Decimal("-122515.28")


def test_adjustment_makes_desired_visible() -> None:
    operations = Decimal("-200.00")
    adjustment = adjustment_for(Decimal("4900.00"), operations)
    assert visible_balance(None, adjustment, operations) == Decimal("4900.00")


def test_reported_zero_is_not_absent() -> None:
    # ноль — законный остаток, а не «источник промолчал»
    assert visible_balance(Decimal(0), Decimal("777.00"), Decimal("13.00")) == Decimal(0)
