import json

from app.ai.client import LLMClient, OpenAICompatLLMClient


class _FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeChoice:
    def __init__(self, content: str) -> None:
        self.message = _FakeMessage(content)


class _FakeCompletion:
    def __init__(self, content: str) -> None:
        self.choices = [_FakeChoice(content)]


class _FakeCompletions:
    def __init__(self, content: str) -> None:
        self._content = content
        self.calls: list[dict[str, object]] = []

    async def create(self, **kwargs: object) -> _FakeCompletion:
        self.calls.append(kwargs)
        return _FakeCompletion(self._content)


class _FakeChat:
    def __init__(self, content: str) -> None:
        self.completions = _FakeCompletions(content)


class _FakeOpenAI:
    """Заглушка AsyncOpenAI: возвращает записанный ответ, минуя сеть."""

    def __init__(self, content: str) -> None:
        self.chat = _FakeChat(content)


async def test_complete_json_returns_message_content() -> None:
    recorded = json.dumps({"category": "Еда", "confidence": 0.91})
    fake = _FakeOpenAI(recorded)
    client: LLMClient = OpenAICompatLLMClient(fake, "test-model")  # type: ignore[arg-type]

    result = await client.complete_json(system="сис", user="польз")

    assert json.loads(result) == {"category": "Еда", "confidence": 0.91}
    # модель и режим JSON переданы провайдеру
    call = fake.chat.completions.calls[0]
    assert call["model"] == "test-model"
    assert call["response_format"] == {"type": "json_object"}


async def test_complete_json_none_content_falls_back_to_empty_object() -> None:
    fake = _FakeOpenAI(None)  # type: ignore[arg-type]
    client = OpenAICompatLLMClient(fake, "test-model")  # type: ignore[arg-type]
    assert await client.complete_json(system="s", user="u") == "{}"
