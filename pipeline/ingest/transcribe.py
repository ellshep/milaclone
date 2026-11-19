"""Speech-to-text with Deepgram's pre-recorded API (POST /v1/listen).

The recording is sent to Deepgram and the transcript comes back in a few
seconds. With mip_opt_out (the default here) Deepgram keeps no audio or
transcript after replying; only request metadata and usage are logged.
"""

from __future__ import annotations

import mimetypes
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

API_URL = "https://api.deepgram.com/v1/listen"
TIMEOUT_S = 120.0

# Container types Deepgram detects itself; this only sets a sensible header.
CONTENT_TYPES = {
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
    ".flac": "audio/flac",
    ".caf": "audio/x-caf",
    ".amr": "audio/amr",
}


# Statuses that mean "try again later": timeout, too many requests, server trouble.
RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}


class TranscribeError(Exception):
    """`retryable` is True for failures that may clear up by themselves
    (Deepgram busy or down, network trouble), False for ones that won't
    (wrong key, no credits, bad audio)."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class Transcript:
    text: str
    audio_seconds: float
    elapsed_ms: int


@dataclass
class DeepgramTranscriber:
    api_key: str
    model: str = "nova-3"
    language: str = "en"
    mip_opt_out: bool = True
    api_url: str = API_URL
    http: httpx.Client | None = None

    def params(self) -> dict:
        p = {"model": self.model, "smart_format": "true", "punctuate": "true"}
        if self.language:
            p["language"] = self.language
        if self.mip_opt_out:
            p["mip_opt_out"] = "true"
        return p

    def transcribe(self, path: Path) -> Transcript:
        if not self.api_key:
            raise TranscribeError("DEEPGRAM_API_KEY is not set")
        ctype = CONTENT_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start = time.monotonic()
        own = self.http is None
        client = self.http or httpx.Client(timeout=TIMEOUT_S)
        try:
            with path.open("rb") as f:
                r = client.post(self.api_url, params=self.params(), content=f.read(),
                                headers={"Authorization": f"Token {self.api_key}", "Content-Type": ctype})
        except httpx.HTTPError as e:
            raise TranscribeError(f"Deepgram unreachable: {type(e).__name__}", retryable=True) from e
        finally:
            if own:
                client.close()
        if r.status_code >= 400:
            raise TranscribeError(f"Deepgram HTTP {r.status_code}: {_err(r)}",
                                  retryable=r.status_code in RETRYABLE_STATUS)
        try:
            data = r.json()
            alt = data["results"]["channels"][0]["alternatives"][0]
            text = (alt.get("transcript") or "").strip()
            seconds = float((data.get("metadata") or {}).get("duration") or 0.0)
        except (ValueError, KeyError, IndexError, TypeError) as e:
            raise TranscribeError("Deepgram response had no transcript") from e
        return Transcript(text, seconds, int((time.monotonic() - start) * 1000))


def _err(r: httpx.Response) -> str:
    try:
        body = r.json()
        msg = body.get("err_msg") or body.get("message") or body.get("error") or ""
    except ValueError:
        msg = r.text
    return str(msg)[:200]
