"""Local speech-to-text with faster-whisper on the CPU. Audio never leaves
the server."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Transcript:
    text: str
    audio_seconds: float
    elapsed_ms: int


class WhisperTranscriber:
    def __init__(self, model: str, threads: int, compute_type: str, models_dir: Path, language: str = ""):
        self.model_name = model
        self.threads = threads
        self.compute_type = compute_type
        self.models_dir = models_dir
        self.language = language or None
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        # Loaded on first use so the service starts (and answers health checks)
        # before the model is downloaded.
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel

                self.models_dir.mkdir(parents=True, exist_ok=True)
                self._model = WhisperModel(
                    self.model_name,
                    device="cpu",
                    compute_type=self.compute_type,
                    cpu_threads=self.threads,
                    download_root=str(self.models_dir),
                )
        return self._model

    def transcribe(self, path: Path) -> Transcript:
        model = self._load()
        start = time.monotonic()
        segments, info = model.transcribe(str(path), language=self.language, vad_filter=True, beam_size=5)
        text = " ".join(s.text.strip() for s in segments).strip()
        return Transcript(text, float(info.duration), int((time.monotonic() - start) * 1000))
