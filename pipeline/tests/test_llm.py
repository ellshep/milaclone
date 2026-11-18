import json
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import httpx2
import pytest

from ingest.config import Settings, StepConfig
from ingest.extract import SCHEMA, build_prompt, extract_tasks
from ingest.llm import LLMError, complete_json
from ingest.extract import Extraction

GOOD = {"summary": "Errands.", "tasks": [
    {"title": "  Buy   printer ink ", "notes": " black ", "tags": ["#errands", " "], "dueDate": "2026-11-19"},
    {"title": "Call mom", "notes": "", "tags": [], "dueDate": "next friday"},
    {"title": "Pay rent", "notes": "", "tags": [], "dueDate": "2026-02-30"},
    {"title": "   ", "notes": "", "tags": [], "dueDate": None},
]}
NOW = datetime(2026, 11, 18, 9, 0, tzinfo=ZoneInfo("America/Chicago"))


def mock(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def amock(handler):
    """The Anthropic SDK runs on httpx2, so its mock client comes from there."""
    return httpx2.Client(transport=httpx2.MockTransport(handler))


def anthropic_reply(text, stop="end_turn"):
    return {
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5",
        "content": [{"type": "text", "text": text}], "stop_reason": stop, "stop_sequence": None,
        "usage": {"input_tokens": 120, "output_tokens": 45},
    }


def test_anthropic_structured_output_and_cleanup(capsys):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx2.Response(200, json=anthropic_reply(json.dumps(GOOD)))

    cfg = StepConfig("extract", "anthropic", "", api_key="sk-test")
    r = extract_tasks("buy printer ink", cfg, "America/Chicago", now=NOW, http=amock(handler))
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1/messages"
    assert seen[0].headers["authorization"] == "Bearer sk-test"
    assert body["model"] == "claude-haiku-5-5"
    assert body["output_config"] == {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}}
    assert "Today is Wednesday, 2026-11-18." in body["messages"][0]["content"]
    assert "<transcript>\nbuy printer ink\n</transcript>" in body["messages"][0]["content"]
    tasks = r.data.tasks
    assert [t.title for t in tasks] == ["Buy printer ink", "Call mom", "Pay rent"]
    assert tasks[0].notes == "black"
    assert tasks[0].tags == ["errands"]
    assert [t.dueDate for t in tasks] == ["2026-11-19", None, None]
    assert (r.input_tokens, r.output_tokens, r.provider, r.attempts) == (120, 45, "anthropic", 1)
    log = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert log[-1]["event"] == "llm.call"
    assert log[-1]["input_tokens"] == 120


def test_retries_once_then_fails():
    calls = []

    def handler(req):
        calls.append(1)
        return httpx2.Response(200, json=anthropic_reply("not json"))

    cfg = StepConfig("extract", "anthropic", "claude-haiku-5-5", api_key="k")
    with pytest.raises(LLMError, match="after 2 attempts"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=amock(handler))
    assert len(calls) == 2


def test_retry_recovers():
    replies = iter([anthropic_reply("{}oops"), anthropic_reply(json.dumps(GOOD))])
    cfg = StepConfig("extract", "anthropic", "claude-haiku-5-5", api_key="k")
    r = complete_json(cfg, "s", "p", Extraction, SCHEMA,
                      http=amock(lambda req: httpx2.Response(200, json=next(replies))))
    assert r.attempts == 2


@pytest.mark.parametrize("stop,msg", [("refusal", "refused"), ("max_tokens", "cut off")])
def test_anthropic_stop_reasons(stop, msg):
    cfg = StepConfig("extract", "anthropic", "claude-haiku-5-5", api_key="k")
    with pytest.raises(LLMError, match=msg):
        complete_json(cfg, "s", "p", Extraction, SCHEMA,
                      http=amock(lambda req: httpx2.Response(200, json=anthropic_reply("{}", stop))))


def test_anthropic_http_error():
    cfg = StepConfig("extract", "anthropic", "claude-haiku-5-5", api_key="k")
    err = {"type": "error", "error": {"type": "invalid_request_error", "message": "bad"}}
    with pytest.raises(LLMError, match="HTTP 400"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=amock(lambda req: httpx2.Response(400, json=err)))


def test_openai_strict_schema():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={
            "choices": [{"message": {"role": "assistant", "content": json.dumps(GOOD)}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 20},
        })

    cfg = StepConfig("extract", "openai", "small-model", api_key="sk-o")
    r = complete_json(cfg, "sys", "prompt", Extraction, SCHEMA, http=mock(handler))
    body = json.loads(seen[0].content)
    assert str(seen[0].url) == "https://api.openai.com/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer sk-o"
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["strict"] is True
    assert body["messages"][0] == {"role": "system", "content": "sys"}
    assert (r.input_tokens, r.output_tokens) == (50, 20)


def test_openai_refusal_and_bad_shape():
    cfg = StepConfig("extract", "openai", "m", api_key="k")
    refusal = {"choices": [{"message": {"content": None, "refusal": "no"}}]}
    with pytest.raises(LLMError, match="refused"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(lambda r: httpx.Response(200, json=refusal)))
    with pytest.raises(LLMError, match="unexpected"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(lambda r: httpx.Response(200, json={})))
    with pytest.raises(LLMError, match="HTTP 429"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(lambda r: httpx.Response(429, text="slow")))
    with pytest.raises(LLMError, match="not JSON"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(lambda r: httpx.Response(200, text="<html>")))

    def down(r):
        raise httpx.ConnectError("refused")

    with pytest.raises(LLMError, match="connection error"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(down))


def test_openai_compatible_local():
    seen = []

    def handler(req):
        seen.append(req)
        fenced = "```json\n" + json.dumps(GOOD) + "\n```"
        return httpx.Response(200, json={"choices": [{"message": {"content": fenced}}]})

    cfg = StepConfig("extract", "openai_compatible", "llama3.2", base_url="http://ollama:11434/v1/")
    r = complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(handler))
    body = json.loads(seen[0].content)
    assert str(seen[0].url) == "http://ollama:11434/v1/chat/completions"
    assert "authorization" not in seen[0].headers
    assert body["response_format"] == {"type": "json_object"}
    assert "JSON Schema" in body["messages"][1]["content"]
    assert r.input_tokens is None
    assert len(r.data.tasks) == 4

    with pytest.raises(LLMError, match="EXTRACT_BASE_URL"):
        complete_json(StepConfig("extract", "openai_compatible", "m"), "s", "p", Extraction, SCHEMA,
                      http=mock(handler))


def test_gemini():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json={
            "candidates": [{"content": {"parts": [{"text": json.dumps(GOOD)}]}}],
            "usageMetadata": {"promptTokenCount": 30, "candidatesTokenCount": 12},
        })

    cfg = StepConfig("extract", "gemini", "flash-model", api_key="g-key")
    r = complete_json(cfg, "sys", "p", Extraction, SCHEMA, http=mock(handler))
    body = json.loads(seen[0].content)
    assert seen[0].url.path == "/v1beta/models/flash-model:generateContent"
    assert seen[0].headers["x-goog-api-key"] == "g-key"
    assert body["generationConfig"] == {"responseMimeType": "application/json"}
    assert body["systemInstruction"]["parts"][0]["text"] == "sys"
    assert (r.input_tokens, r.output_tokens) == (30, 12)

    blocked = {"promptFeedback": {"blockReason": "SAFETY"}}
    with pytest.raises(LLMError, match="blocked: SAFETY"):
        complete_json(cfg, "s", "p", Extraction, SCHEMA, http=mock(lambda req: httpx.Response(200, json=blocked)))


def test_config_errors():
    with pytest.raises(LLMError, match="unknown provider"):
        complete_json(StepConfig("extract", "nope", "m"), "s", "p", Extraction, SCHEMA)
    with pytest.raises(LLMError, match="EXTRACT_MODEL is required"):
        complete_json(StepConfig("extract", "openai", ""), "s", "p", Extraction, SCHEMA)


def test_fake_provider(monkeypatch):
    cfg = StepConfig("extract", "fake", "")
    r = extract_tasks("buy milk. call mom!", cfg, "America/Chicago", now=NOW)
    assert [t.title for t in r.data.tasks] == ["Buy milk", "Call mom"]
    monkeypatch.setenv("FAKE_LLM_RESPONSE", json.dumps({"summary": "s", "tasks": []}))
    assert extract_tasks("anything", cfg, "America/Chicago", now=NOW).data.tasks == []


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("INGEST_API_TOKEN", " tok ")
    monkeypatch.setenv("APP_URL", "http://x:1/")
    monkeypatch.setenv("EXTRACT_PROVIDER", "OpenAI")
    monkeypatch.setenv("EXTRACT_MODEL", "m")
    monkeypatch.setenv("WHISPER_THREADS", "4")
    s = Settings.from_env()
    assert s.ingest_token == "tok"
    assert s.app_url == "http://x:1"
    assert s.extract.provider == "openai"
    assert s.extract.model == "m"
    assert s.whisper_threads == 4
    assert s.whisper_model == "base"


def test_prompt_mentions_rules():
    p = build_prompt("hello", NOW.date())
    assert "Do not invent tasks" in p
    assert "Today is Wednesday, 2026-11-18." in p
