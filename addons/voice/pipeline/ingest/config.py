"""Settings, read from environment variables once per app instance."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _delays(raw: str) -> tuple[int, ...]:
    """Seconds to wait before each transcription retry, e.g. "60,300,900".
    Empty or "0" turns retries off."""
    out = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        n = int(part)
        if n < 0:
            raise ValueError("TRANSCRIBE_RETRY_DELAYS values must be 0 or more")
        if n:
            out.append(n)
    return tuple(out)


@dataclass(frozen=True)
class StepConfig:
    """Which model one pipeline step uses. Steps are configured separately
    (EXTRACT_* now, RANK_* for the nightly ranking later)."""

    step: str
    provider: str
    model: str
    api_key: str = ""
    base_url: str = ""

    @classmethod
    def from_env(cls, step: str) -> "StepConfig":
        prefix = step.upper()
        provider = _env(f"{prefix}_PROVIDER", "anthropic").lower()
        return cls(
            step=step,
            provider=provider,
            model=_env(f"{prefix}_MODEL"),
            api_key=_env(f"{prefix}_API_KEY"),
            base_url=_env(f"{prefix}_BASE_URL"),
        )


@dataclass(frozen=True)
class Settings:
    ingest_token: str = ""
    task_token: str = ""
    app_url: str = "http://app:4321"
    data_dir: Path = Path("/data")
    tz: str = "UTC"
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-3"
    deepgram_language: str = "en"
    deepgram_mip_opt_out: bool = True
    retry_delays: tuple[int, ...] = (60, 300, 900)
    alert_webhook_url: str = ""
    review_url: str = ""
    max_audio_mb: int = 50
    extract: StepConfig = field(default_factory=lambda: StepConfig("extract", "fake", "fake"))

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            ingest_token=_env("INGEST_API_TOKEN"),
            task_token=_env("TASK_API_TOKEN"),
            app_url=_env("APP_URL", "http://app:4321").rstrip("/"),
            data_dir=Path(_env("DATA_DIR", "/data")),
            tz=_env("TASK_TZ") or "UTC",
            deepgram_api_key=_env("DEEPGRAM_API_KEY"),
            deepgram_model=_env("DEEPGRAM_MODEL", "nova-3"),
            deepgram_language=_env("DEEPGRAM_LANGUAGE", "en"),
            deepgram_mip_opt_out=_env("DEEPGRAM_MIP_OPT_OUT", "true").lower() not in ("false", "0", "no"),
            retry_delays=_delays(_env("TRANSCRIBE_RETRY_DELAYS", "60,300,900")),
            alert_webhook_url=_env("ALERT_WEBHOOK_URL"),
            review_url=_env("INGEST_REVIEW_URL"),
            max_audio_mb=int(_env("MAX_AUDIO_MB", "50")),
            extract=StepConfig.from_env("extract"),
        )
