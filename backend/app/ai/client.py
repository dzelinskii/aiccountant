from typing import Protocol

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from app.core.settings import get_settings


class LLMClient(Protocol):
    """Провайдеро-независимый интерфейс LLM. Реализации — только в модуле ai."""

    async def complete_json(self, *, system: str, user: str) -> str:
        """Вернуть ответ модели как JSON-текст (провайдер обязан вернуть валидный JSON)."""
        ...


class OpenAICompatLLMClient:
    """Реализация через OpenAI-совместимый эндпоинт (OpenAI, OpenRouter, DeepSeek,
    Gemini-compat, локальный Ollama — отличаются лишь base_url/модель)."""

    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self._model = model

    async def complete_json(self, *, system: str, user: str) -> str:
        messages: list[ChatCompletionMessageParam] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        resp = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0,
        )
        return resp.choices[0].message.content or "{}"


def build_llm_client() -> OpenAICompatLLMClient:
    settings = get_settings()
    client = AsyncOpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key or "unset")
    return OpenAICompatLLMClient(client, settings.llm_model_categorize)
