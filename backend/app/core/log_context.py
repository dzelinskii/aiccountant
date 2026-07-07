import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response


class LogContextMiddleware(BaseHTTPMiddleware):
    """Чистит structlog-contextvars на входе, чтобы значения не протекали
    между запросами; сами идентификаторы привязывают зависимости."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        structlog.contextvars.clear_contextvars()
        return await call_next(request)
