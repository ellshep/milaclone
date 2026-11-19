"""Provider-agnostic JSON completion.

Every model-backed step (task extraction now, nightly ranking later) calls
`complete_json` with its own StepConfig, so each step can use a different
provider and model. The answer is validated against a pydantic model; a bad
answer is retried once, then LLMError is raised and the caller falls back.

Providers:
  anthropic          Official Anthropic SDK, structured outputs (output_config.format).
  openai             Chat Completions with a strict json_schema response format.
  gemini             generateContent with a JSON response MIME type.
  openai_compatible  Any OpenAI-style endpoint (Ollama, llama.cpp, vLLM) in JSON mode.
  fake               No network; for tests and local smoke runs.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable

import httpx
from pydantic import BaseModel, ValidationError

from .config import StepConfig
from .logs import log

# Cheapest current tier per provider, used when <STEP>_MODEL is unset. Only
# Anthropic has a default here; the other providers need an explicit model
# so a stale name never ships silently.
DEFAULT_MODELS = {"anthropic": "claude-haiku-5-5", "fake": "fake"}

MAX_TOKENS = 8000
TIMEOUT_S = 60.0


class LLMError(Exception):
    pass


@dataclass
class LLMResult:
    data: BaseModel
    provider: str
    model: str
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int
    attempts: int


@dataclass
class _Raw:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None


Caller = Callable[[StepConfig, str, str, str, dict, httpx.Client | None], _Raw]


def _schema_hint(schema: dict) -> str:
    return "Respond with only a JSON object matching this JSON Schema:\n" + json.dumps(schema)


def _new_anthropic(api_key, base_url, http=None):
    import anthropic

    return anthropic.Anthropic(
        api_key=api_key or None,
        base_url=base_url or None,
        timeout=TIMEOUT_S,
        max_retries=2,
        # The SDK runs on httpx2; only an httpx2 client (tests pass a mock one) is handed over.
        http_client=http if type(http).__module__.partition(".")[0] == "httpx2" else None,
    )


@lru_cache(maxsize=4)
def _anthropic_client(api_key, base_url):
    """One client per key, so calls reuse its connection pool."""
    return _new_anthropic(api_key, base_url)


def preload(cfg: StepConfig) -> None:
    """Import the provider SDK and build its client before the first request.

    Importing the Anthropic SDK costs about 4 s of CPU, 7-9 s under the
    pipeline's 0.5 CPU cap. Done lazily, that lands on the first note after
    every restart, longer than the Alexa Worker waits. main.py runs this in a
    background thread at startup; a request that arrives mid-import waits on
    the import lock instead of importing twice.
    """
    if cfg.provider != "anthropic":
        return
    start = time.monotonic()
    try:
        _anthropic_client(cfg.api_key, cfg.base_url)
    except Exception as e:  # the first real call reports it properly
        log("llm.preload_failed", step=cfg.step, provider=cfg.provider, error=str(e))
        return
    log("llm.preloaded", step=cfg.step, provider=cfg.provider, ms=int((time.monotonic() - start) * 1000))


def _call_anthropic(cfg, model, system, prompt, schema, http):
    import anthropic

    client = _new_anthropic(cfg.api_key, cfg.base_url, http) if http else _anthropic_client(cfg.api_key, cfg.base_url)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": prompt}],
            # Small, well-specified task: low effort keeps it fast and cheap.
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.APIStatusError as e:
        raise LLMError(f"anthropic HTTP {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise LLMError(f"anthropic connection error: {e}") from e
    if resp.stop_reason == "refusal":
        raise LLMError("anthropic refused the request")
    if resp.stop_reason == "max_tokens":
        raise LLMError("anthropic answer was cut off at max_tokens")
    text = next((b.text for b in resp.content if b.type == "text"), "")
    return _Raw(text, resp.usage.input_tokens, resp.usage.output_tokens)


def _post(http, url, headers, body):
    own = http is None
    client = http or httpx.Client(timeout=TIMEOUT_S)
    try:
        r = client.post(url, headers=headers, json=body)
    except httpx.HTTPError as e:
        raise LLMError(f"connection error: {e}") from e
    finally:
        if own:
            client.close()
    if r.status_code >= 400:
        raise LLMError(f"HTTP {r.status_code}: {r.text[:300]}")
    try:
        return r.json()
    except ValueError as e:
        raise LLMError("response was not JSON") from e


def _openai_like(cfg, model, system, prompt, schema, http, *, base_default, response_format):
    base = (cfg.base_url or base_default).rstrip("/")
    if not base:
        raise LLMError(f"{cfg.step.upper()}_BASE_URL is required for provider {cfg.provider}")
    headers = {"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "response_format": response_format,
    }
    data = _post(http, base + "/chat/completions", headers, body)
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as e:
        raise LLMError("unexpected response shape") from e
    if msg.get("refusal"):
        raise LLMError(f"model refused: {msg['refusal']}")
    usage = data.get("usage") or {}
    return _Raw(msg.get("content") or "", usage.get("prompt_tokens"), usage.get("completion_tokens"))


def _call_openai(cfg, model, system, prompt, schema, http):
    fmt = {"type": "json_schema", "json_schema": {"name": "result", "strict": True, "schema": schema}}
    return _openai_like(cfg, model, system, prompt, schema, http,
                        base_default="https://api.openai.com/v1", response_format=fmt)


def _call_openai_compatible(cfg, model, system, prompt, schema, http):
    # Local servers vary in schema support; JSON mode plus the schema in the
    # prompt works broadly, and the answer is validated either way.
    return _openai_like(cfg, model, system, prompt + "\n\n" + _schema_hint(schema), schema, http,
                        base_default="", response_format={"type": "json_object"})


def _call_gemini(cfg, model, system, prompt, schema, http):
    base = (cfg.base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt + "\n\n" + _schema_hint(schema)}]}],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    data = _post(http, f"{base}/models/{model}:generateContent", {"x-goog-api-key": cfg.api_key}, body)
    try:
        cand = data["candidates"][0]
        text = "".join(p.get("text", "") for p in cand["content"]["parts"])
    except (KeyError, IndexError, TypeError) as e:
        reason = (data.get("promptFeedback") or {}).get("blockReason") if isinstance(data, dict) else None
        raise LLMError(f"no answer from gemini{f' (blocked: {reason})' if reason else ''}") from e
    usage = data.get("usageMetadata") or {}
    return _Raw(text, usage.get("promptTokenCount"), usage.get("candidatesTokenCount"))


def _call_fake(cfg, model, system, prompt, schema, http):
    """FAKE_LLM_RESPONSE (a JSON string) if set; otherwise one task per
    sentence of the <transcript> block, for local smoke runs without a key."""
    canned = os.environ.get("FAKE_LLM_RESPONSE")
    if canned:
        return _Raw(canned, 0, 0)
    m = re.search(r"<transcript>\n?(.*?)\n?</transcript>", prompt, re.S)
    text = m.group(1).strip() if m else ""
    sentences = [s.strip(" .!?") for s in re.split(r"[.!?\n]+", text) if s.strip(" .!?")]
    tasks = [{"title": s[:1].upper() + s[1:], "notes": "", "tags": [], "dueDate": None} for s in sentences]
    return _Raw(json.dumps({"summary": text[:200], "tasks": tasks}), 0, 0)


PROVIDERS: dict[str, Caller] = {
    "anthropic": _call_anthropic,
    "openai": _call_openai,
    "gemini": _call_gemini,
    "openai_compatible": _call_openai_compatible,
    "fake": _call_fake,
}


def _parse(text: str, model_cls: type[BaseModel]) -> BaseModel:
    s = text.strip()
    # Tolerate a fenced block from providers without strict JSON modes.
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", s, re.S)
    if fence:
        s = fence.group(1)
    try:
        return model_cls.model_validate_json(s)
    except ValidationError as e:
        raise LLMError(f"answer did not match the schema: {e.errors()[:3]}") from e


def complete_json(cfg: StepConfig, system: str, prompt: str, model_cls: type[BaseModel], schema: dict,
                  *, http=None) -> LLMResult:
    """`http` is an optional client for tests: httpx for the REST providers,
    httpx2 for the Anthropic SDK."""
    call = PROVIDERS.get(cfg.provider)
    if call is None:
        raise LLMError(f"unknown provider {cfg.provider!r} (use one of {', '.join(sorted(PROVIDERS))})")
    model = cfg.model or DEFAULT_MODELS.get(cfg.provider, "")
    if not model:
        raise LLMError(f"{cfg.step.upper()}_MODEL is required for provider {cfg.provider}")

    last: LLMError | None = None
    for attempt in (1, 2):
        start = time.monotonic()
        try:
            raw = call(cfg, model, system, prompt, schema, http)
            data = _parse(raw.text, model_cls)
        except LLMError as e:
            last = e
            log("llm.error", step=cfg.step, provider=cfg.provider, model=model, attempt=attempt,
                latency_ms=int((time.monotonic() - start) * 1000), error=str(e))
            continue
        latency = int((time.monotonic() - start) * 1000)
        log("llm.call", step=cfg.step, provider=cfg.provider, model=model, attempt=attempt,
            input_tokens=raw.input_tokens, output_tokens=raw.output_tokens, latency_ms=latency)
        return LLMResult(data, cfg.provider, model, raw.input_tokens, raw.output_tokens, latency, attempt)
    raise LLMError(f"{cfg.step} failed after 2 attempts: {last}")
