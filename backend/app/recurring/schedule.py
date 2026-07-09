from calendar import monthrange
from datetime import date, timedelta


def _clamp(year: int, month: int, day: int) -> date:
    last = monthrange(year, month)[1]
    return date(year, month, min(day, last))


def _add_months(d: date, months: int, day: int) -> date:
    total = d.year * 12 + (d.month - 1) + months
    year, month = divmod(total, 12)
    return _clamp(year, month + 1, day)


def _first_slot(period: str, anchor_day: int | None, start_date: date) -> date:
    if period == "month":
        assert anchor_day is not None
        return _clamp(start_date.year, start_date.month, anchor_day)
    # day/week/year — якорь задаёт сам start_date
    return start_date


def _advance(slot: date, period: str, interval: int, anchor_day: int | None) -> date:
    if period == "day":
        return slot + timedelta(days=interval)
    if period == "week":
        return slot + timedelta(weeks=interval)
    if period == "month":
        assert anchor_day is not None
        return _add_months(slot, interval, anchor_day)
    if period == "year":
        return _add_months(slot, interval * 12, slot.day)
    raise ValueError(f"неизвестный период: {period}")


def next_run_from(
    period: str, interval: int, anchor_day: int | None, start_date: date, after: date
) -> date:
    """Ближайший слот расписания строго больше `after`."""
    slot = _first_slot(period, anchor_day, start_date)
    while slot <= after:
        slot = _advance(slot, period, interval, anchor_day)
    return slot


def compute_initial_next_run(
    period: str, interval: int, anchor_day: int | None, start_date: date
) -> date:
    """Первое срабатывание — ближайший слот не раньше start_date."""
    return next_run_from(
        period, interval, anchor_day, start_date, after=start_date - timedelta(days=1)
    )
