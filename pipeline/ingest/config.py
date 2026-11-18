"""Settings, read from environment variables once per app instance."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


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
    tz: str = "America/Chicago"
    whisper_model: str = "base"
    whisper_threads: int = 2
    whisper_compute: str = "int8"
    whisper_language: str = ""
    models_dir: Path = Path("/models")
    max_audio_mb: int = 50
    extract: StepConfig = field(default_factory=lambda: StepConfig("extract", "fake", "fake"))

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            ingest_token=_env("INGEST_API_TOKEN"),
            task_token=_env("TASK_API_TOKEN"),
            app_url=_env("APP_URL", "http://app:4321").rstrip("/"),
            data_dir=Path(_env("DATA_DIR", "/data")),
            tz=_env("TASK_TZ", "America/Chicago"),
            whisper_model=_env("WHISPER_MODEL", "base"),
            whisper_threads=int(_env("WHISPER_THREADS", "2")),
            whisper_compute=_env("WHISPER_COMPUTE_TYPE", "int8"),
            whisper_language=_env("WHISPER_LANGUAGE"),
            models_dir=Path(_env("WHISPER_MODELS_DIR", "/models")),
            max_audio_mb=int(_env("MAX_AUDIO_MB", "50")),
            extract=StepConfig.from_env("extract"),
        )
