"""Turn a transcript into tasks through the LLM provider abstraction."""

from __future__ import annotations

import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

import httpx
from pydantic import BaseModel, Field

from .config import StepConfig
from .llm import LLMResult, complete_json


class ExtractedTask(BaseModel):
    title: str = Field(min_length=1)
    notes: str = ""
    tags: list[str] = []
    dueDate: str | None = None


class Extraction(BaseModel):
    summary: str = ""
    tasks: list[ExtractedTask] = []


SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "One or two sentences summarising the whole note."},
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short imperative action, e.g. 'Buy printer ink'."},
                    "notes": {"type": "string", "description": "Extra detail the speaker gave, or empty."},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "dueDate": {"type": ["string", "null"], "description": "YYYY-MM-DD, or null."},
                },
                "required": ["title", "notes", "tags", "dueDate"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "tasks"],
    "additionalProperties": False,
}

SYSTEM = (
    "You turn a voice note transcript into to-do tasks for one person's task list. "
    "The transcript comes from speech recognition and may contain filler words or recognition errors."
)

RULES = """Rules:
- Extract only genuine action items the speaker intends to do. Do not invent tasks that were not said.
- Ideas, observations and background are not tasks unless the speaker says to act on them.
- Titles are short and imperative ("Call the dentist", "Buy printer ink"). Put any extra detail in notes.
- Resolve relative dates ("tomorrow", "next Friday", "end of the month") to YYYY-MM-DD using today's date
  below. If no date or deadline was said for a task, dueDate is null.
- Tags: only add a tag if the speaker names a category or project for the task; otherwise use an empty list.
- If the note contains no action items, return an empty tasks list.
- summary: one or two sentences describing the whole note."""


def build_prompt(transcript: str, today: date) -> str:
    return (
        f"Today is {today.strftime('%A')}, {today.isoformat()}.\n\n{RULES}\n\n"
        f"<transcript>\n{transcript}\n</transcript>"
    )


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _clean_due(v: str | None) -> str | None:
    if not v or not DATE_RE.match(v):
        return None
    try:
        date.fromisoformat(v)
    except ValueError:
        return None
    return v


def extract_tasks(transcript: str, cfg: StepConfig, tz: str, *, now: datetime | None = None,
                  http: httpx.Client | None = None) -> LLMResult:
    """Raises LLMError when the model fails twice; the caller keeps the transcript."""
    today = (now or datetime.now(ZoneInfo(tz))).astimezone(ZoneInfo(tz)).date()
    result = complete_json(cfg, SYSTEM, build_prompt(transcript, today), Extraction, SCHEMA, http=http)
    ext: Extraction = result.data  # type: ignore[assignment]
    cleaned = []
    for t in ext.tasks:
        title = " ".join(t.title.split())
        if not title:
            continue
        tags = [g.strip().lstrip("#").strip() for g in t.tags]
        cleaned.append(ExtractedTask(title=title, notes=t.notes.strip(),
                                     tags=[g for g in tags if g], dueDate=_clean_due(t.dueDate)))
    result.data = Extraction(summary=ext.summary.strip(), tasks=cleaned)
    return result
