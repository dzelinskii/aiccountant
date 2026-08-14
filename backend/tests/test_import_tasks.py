def test_llm_call_fits_into_stuck_threshold() -> None:
    """Худший случай вызова LLM обязан укладываться в порог reaper'а, иначе он
    добьёт живой разбор."""
    from app.ai.client import build_llm_client
    from app.imports.tasks import STUCK_AFTER

    client = build_llm_client()._client
    timeout = client.timeout
    # клиент строится с числовым timeout (не httpx.Timeout/None) — проверяем
    # инвариант на реальном значении, а не гадаем тип для mypy
    assert isinstance(timeout, int | float)
    worst_case = timeout * (client.max_retries + 1)
    assert worst_case < STUCK_AFTER.total_seconds()
