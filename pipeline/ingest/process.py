"""The steps of one ingest: transcribe (audio only), extract, create tasks.
Each step's output is saved before the next runs, so a failure keeps what
came before it."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from .config import Settings
from .extract import Extraction, extract_tasks
from .llm import LLMError, LLMResult
from .logs import log
from .store import Store
from .tasks_client import TaskAPIError, TasksClient
from .transcribe import Transcript


class Transcriber(Protocol):
    def transcribe(self, path: Path) -> Transcript: ...


Extractor = Callable[[str], LLMResult]


@dataclass
class Deps:
    settings: Settings
    store: Store
    transcriber: Transcriber
    tasks: TasksClient
    extractor: Extractor

    @property
    def audio_dir(self) -> Path:
        return self.settings.data_dir / "audio"


def default_extractor(settings: Settings) -> Extractor:
    return lambda transcript: extract_tasks(transcript, settings.extract, settings.tz)


def extract_and_create(deps: Deps, ingest_id: str, transcript: str, source: str) -> dict:
    store = deps.store
    if not transcript.strip():
        store.update(ingest_id, status="done", extraction_json={"summary": "", "tasks": []},
                     created_json=[], skipped_json=[])
        log("ingest.done", id=ingest_id, created=0, skipped=0, note="empty transcript")
        return store.get(ingest_id)

    store.update(ingest_id, status="extracting")
    start = time.monotonic()
    try:
        result = deps.extractor(transcript)
    except LLMError as e:
        # The raw transcript is already stored; nothing is lost.
        store.update(ingest_id, status="extraction_failed", error=str(e),
                     extract_ms=int((time.monotonic() - start) * 1000))
        log("ingest.extraction_failed", id=ingest_id, error=str(e))
        return store.get(ingest_id)

    ext: Extraction = result.data  # type: ignore[assignment]
    store.update(ingest_id, extraction_json={
        **ext.model_dump(),
        "provider": result.provider,
        "model": result.model,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
    }, extract_ms=int((time.monotonic() - start) * 1000))

    created, skipped, errors = [], [], []
    for task in ext.tasks:
        try:
            r = deps.tasks.create(task, source)
        except TaskAPIError as e:
            errors.append(f"{task.title}: {e}")
            continue
        entry = {"id": r["task"]["id"], "title": r["task"]["text"], "listTitle": r["task"].get("listTitle")}
        if r["created"]:
            created.append(entry)
        else:
            skipped.append({**entry, "reason": "duplicate" if r["duplicate"] else "exists"})

    status = "error" if errors else "done"
    store.update(ingest_id, status=status, created_json=created, skipped_json=skipped,
                 error="; ".join(errors) if errors else None)
    log("ingest.done", id=ingest_id, status=status, created=len(created), skipped=len(skipped),
        failed=len(errors), source=source)
    return store.get(ingest_id)


def process_audio(deps: Deps, job: dict) -> dict:
    ingest_id = job["id"]
    deps.store.update(ingest_id, status="transcribing")
    path = deps.audio_dir / job["audio_filename"]
    try:
        t = deps.transcriber.transcribe(path)
    except Exception as e:  # any decoder or model failure is recorded, never raised
        deps.store.update(ingest_id, status="error", error=f"transcription failed: {e}")
        log("ingest.transcribe_failed", id=ingest_id, error=str(e))
        return deps.store.get(ingest_id)
    deps.store.update(ingest_id, transcript=t.text, transcribe_ms=t.elapsed_ms, audio_seconds=t.audio_seconds)
    log("ingest.transcribed", id=ingest_id, audio_seconds=round(t.audio_seconds, 1), transcribe_ms=t.elapsed_ms,
        chars=len(t.text))
    return extract_and_create(deps, ingest_id, t.text, job["source"])


def speech_for(record: dict) -> str:
    """A short sentence a voice assistant can read back."""
    created = [c["title"] for c in record.get("created") or []]
    skipped = [s["title"] for s in record.get("skipped") or []]
    if record["status"] == "extraction_failed":
        return "I saved your note, but couldn't pick out tasks from it."
    if record["status"] == "error" and not created:
        return "Sorry, I couldn't add that."
    parts = []
    if created:
        parts.append("Added " + _join(created) + ".")
    if skipped:
        parts.append(_join(skipped) + (" is" if len(skipped) == 1 else " are") + " already on your list.")
    return " ".join(parts) or "I didn't hear any tasks in that."


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]
