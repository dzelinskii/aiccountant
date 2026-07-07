import structlog
from starlette.types import ASGIApp, Receive, Scope, Send


class LogContextMiddleware:
    """Чистит structlog-contextvars в начале каждого запроса, чтобы значения не
    протекали между запросами; сами идентификаторы привязывают зависимости.

    Реализован как чистый ASGI-middleware намеренно: BaseHTTPMiddleware выполняет
    приложение в отдельной anyio-задаче с копией контекста, и привязанные внутри
    запроса contextvars туда не поднимаются. Чистый ASGI работает в общем
    контексте, поэтому привязка доступна и логам, и вышестоящему коду."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            structlog.contextvars.clear_contextvars()
        await self.app(scope, receive, send)
