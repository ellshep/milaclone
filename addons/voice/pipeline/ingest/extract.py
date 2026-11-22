"""Turn a transcript into tasks through the LLM provider abstraction."""

from __future__ import annotations

import copy
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
    listName: str | None = None  # a Filing list's title, only when the speaker named it


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
- If the note contains no action items, return an empty tasks list.
- summary: one or two sentences describing the whole note."""


def build_schema(tags: tuple[str, ...] = (), lists: tuple[str, ...] = ()) -> dict:
    """The output schema. With existing tags, a task's tags can only be those;
    with Filing lists, a task may name one of them (or null) as its list."""
    if not tags and not lists:
        return SCHEMA
    schema = copy.deepcopy(SCHEMA)
    item = schema["properties"]["tasks"]["items"]
    if tags:
        item["properties"]["tags"]["items"] = {"type": "string", "enum": list(tags)}
    if lists:
        item["properties"]["listName"] = {"type": ["string", "null"], "enum": [*lists, None]}
        item["required"] = [*item["required"], "listName"]
    return schema


def _tag_rule(tags: tuple[str, ...]) -> str:
    if not tags:
        return "- Tags: the task list has no tags yet, so tags is always an empty list."
    return ("- Tags: give a task any of these existing tags that clearly fit it, and never invent a new one. "
            "If none fits, use an empty list.\n  Existing tags: " + ", ".join(tags))


def _list_rule(lists: tuple[str, ...]) -> str:
    if not lists:
        return ""
    return ("\n- List: set a task's listName only when the speaker names one of these lists for it "
            "(\"put X on Errands\", \"for the garden list\"); otherwise null. Never guess from the topic.\n"
            "  Lists: " + ", ".join(lists))


def build_prompt(transcript: str, today: date, tags: tuple[str, ...] = (), lists: tuple[str, ...] = ()) -> str:
    return (
        f"Today is {today.strftime('%A')}, {today.isoformat()}.\n\n{RULES}\n{_tag_rule(tags)}{_list_rule(lists)}\n\n"
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


def extract_tasks(transcript: str, cfg: StepConfig, tz: str, *, tags: tuple[str, ...] = (),
                  lists: tuple[str, ...] = (), now: datetime | None = None,
                  http: httpx.Client | None = None) -> LLMResult:
    """Raises LLMError when the model fails twice; the caller keeps the transcript.
    `tags` are the tags already on the task list; a task only ever gets those.
    `lists` are the Filing lists' titles; a task's `listName` is one of them or None."""
    today = (now or datetime.now(ZoneInfo(tz))).astimezone(ZoneInfo(tz)).date()
    result = complete_json(cfg, SYSTEM, build_prompt(transcript, today, tags, lists), Extraction,
                           build_schema(tags, lists), http=http)
    # Providers without a strict schema (or an old answer) could still name
    # another tag or list: keep only existing ones, in the board's own spelling.
    known = {t.lower(): t for t in tags}
    filing = {name.lower(): name for name in lists}
    ext: Extraction = result.data  # type: ignore[assignment]
    cleaned = []
    for t in ext.tasks:
        title = " ".join(t.title.split())
        if not title:
            continue
        picked = [known.get(g.strip().lstrip("#").strip().lower()) for g in t.tags]
        cleaned.append(ExtractedTask(title=title, notes=t.notes.strip(),
                                     tags=list(dict.fromkeys(g for g in picked if g)), dueDate=_clean_due(t.dueDate),
                                     listName=filing.get((t.listName or "").strip().lower())))
    result.data = Extraction(summary=ext.summary.strip(), tasks=cleaned)
    return result
