import io

from reportlab.pdfgen import canvas


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
