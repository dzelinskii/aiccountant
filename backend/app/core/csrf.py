from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.core.settings import get_settings

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


class OriginCheckMiddleware(BaseHTTPMiddleware):
    """Защита от CSRF: изменяющие запросы принимаются только со своего origin.

    Браузер не позволяет чужому сайту подделать заголовок Origin, поэтому
    сравнение netloc из Origin с Host отсекает cross-site запросы; запросы
    без Origin (curl, тесты, same-origin навигация) пропускаются.
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        origin = request.headers.get("origin")
        if request.method in UNSAFE_METHODS and origin is not None:
            host = request.headers.get("host", "")
            if urlparse(origin).netloc != host and origin not in get_settings().allowed_origins:
                return JSONResponse({"detail": "Запрос с чужого origin отклонён"}, status_code=403)
        return await call_next(request)
