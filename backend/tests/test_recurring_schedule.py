from datetime import date

from app.recurring.schedule import compute_initial_next_run, next_run_from


def test_daily_interval() -> None:
    start = date(2026, 7, 1)
    assert compute_initial_next_run("day", 3, None, start) == date(2026, 7, 1)
    assert next_run_from("day", 3, None, start, after=date(2026, 7, 1)) == date(2026, 7, 4)


def test_weekly_keeps_weekday() -> None:
    start = date(2026, 7, 1)  # среда
    nxt = next_run_from("week", 1, None, start, after=start)
    assert nxt == date(2026, 7, 8)
    assert nxt.weekday() == start.weekday()


def test_monthly_anchor_and_clamp() -> None:
    # якорь 31-е: в феврале клампится на последний день месяца
    start = date(2026, 1, 31)
    assert compute_initial_next_run("month", 1, 31, start) == date(2026, 1, 31)
    assert next_run_from("month", 1, 31, start, after=date(2026, 1, 31)) == date(2026, 2, 28)


def test_monthly_anchor_before_start_skips_to_next_month() -> None:
    # старт 10-го, якорь 5-е: первый слот — 5-е следующего месяца
    start = date(2026, 7, 10)
    assert compute_initial_next_run("month", 1, 5, start) == date(2026, 8, 5)


def test_quarterly_is_month_interval_3() -> None:
    start = date(2026, 1, 15)
    assert next_run_from("month", 3, 15, start, after=date(2026, 1, 15)) == date(2026, 4, 15)


def test_yearly_leap_clamp() -> None:
    start = date(2024, 2, 29)  # високосный
    assert next_run_from("year", 1, None, start, after=date(2024, 2, 29)) == date(2025, 2, 28)


def test_start_in_past_jumps_to_next_future_slot() -> None:
    start = date(2026, 1, 5)
    # «сегодня» 2026-07-20 → ближайший будущий слот месячного правила (5-е)
    assert next_run_from("month", 1, 5, start, after=date(2026, 7, 20)) == date(2026, 8, 5)
