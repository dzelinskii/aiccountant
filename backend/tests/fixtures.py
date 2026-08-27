import io
from collections.abc import Awaitable, Callable

from reportlab.pdfgen import canvas

from app.imports.parser import ParsedStatement


def make_simple_pdf(lines: list[str]) -> bytes:
    """Собрать простой PDF: по строке на drawString (pypdf извлечёт их построчно).
    Только для теста обёртки extract_lines; символ ₽ здесь не используется —
    стандартный шрифт reportlab его не рендерит (см. стратегию тестов)."""
    buf = io.BytesIO()
    pdf = canvas.Canvas(buf)
    y = 800
    for line in lines:
        pdf.drawString(40, y, line)
        y -= 16
    pdf.save()
    return buf.getvalue()


def fixed_parse(
    statement: ParsedStatement, name: str
) -> Callable[[list[str]], Awaitable[tuple[ParsedStatement, str]]]:
    """Колбэк разбора с заранее известным результатом — разбор в бою асинхронный
    (LLM ходит по сети), в тестах результат подставляем напрямую, не гоняя парсер."""

    async def _parse(lines: list[str]) -> tuple[ParsedStatement, str]:
        return statement, name

    return _parse
