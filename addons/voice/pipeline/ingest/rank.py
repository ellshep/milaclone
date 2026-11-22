"""The nightly ranking (next-phases M2.3): orders open tasks for the focus page.

    python -m ingest.rank             # the Compose service: 03:00 in TASK_TZ, if RANK_SCHEDULE=on
    python -m ingest.rank --dry-run   # rank once, print what would be written, write nothing

The app's fixed order (focus.js) stays in charge: overdue, due-today and
hand-placed tasks are never sent or touched. The model scores the rest within
their tier (soon, starred, rest), gives a one-line reason and may move a few a
tier (RANK_NUDGE: off, one-tier = at most 3 a night, free = no cap). It reads
the Home note headed "Focus priorities" too. Everything goes in one
PUT /api/tasks/rank, written only when every step worked, so any failure
leaves the fixed order as it was. There is no stale rule yet (N22).

Nightly filing (M3.3): Inbox tasks among those sent may be filed into the one
list labelled Filing that clearly fits, at most FILE_CAP a night, with a reason.
The moves ride in the same PUT (movedBy "ranker"). A task the owner sent back
to the Inbox (its last move was theirs) is never filed again. Each run then
writes the "Filing log" document card on Home through the board's HTTP API:
the run's time and, for every Inbox task it considered, moved where or left,
and why. Newest run first, the last LOG_RUNS kept.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel

from .config import Settings, StepConfig, _env
from .llm import LLMError, complete_json
from .logs import log
from .tasks_client import TaskAPIError, TasksClient

DEFAULT_MODEL = "claude-opus-5-5"  # N7, at the low effort llm.py always asks for
PRICES = {"claude-opus-5-5": (4.0, 20.0)}  # USD per million input / output tokens
TIERS = ("soon", "starred", "rest")  # focus.js tiers the ranker may order
NUDGE_CAP = 3
# The first this many rankable tasks (in the current order) go to the model, so
# the answer fits in max_tokens; the rest keep their last score.
MAX_TASKS = 200
REASON_MAX = 300
FILE_CAP = 10  # Inbox tasks filed a night, at most (M3.3)
LOG_TITLE = "Filing log"
LOG_RUNS = 30  # runs the filing log keeps


class RankedTask(BaseModel):
    n: int
    score: float
    reason: str
    move: Literal["up", "down", "none"]
    file: str | None = None  # a Filing list's title, for an Inbox task that clearly fits one
    fileReason: str = ""


class Ranking(BaseModel):
    tasks: list[RankedTask]


SCHEMA = {
    "type": "object",
    "properties": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer", "description": "The task's number in the list."},
                    "score": {"type": "number", "description": "0 to 100: how much it matters to do soon."},
                    "reason": {"type": "string", "description": "One short line saying why."},
                    "move": {"type": "string", "enum": ["up", "down", "none"]},
                },
                "required": ["n", "score", "reason", "move"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["tasks"],
    "additionalProperties": False,
}


def build_schema(lists: tuple[str, ...] = ()) -> dict:
    """The answer's schema; with Filing lists, each task may name one as `file`."""
    if not lists:
        return SCHEMA
    schema = json.loads(json.dumps(SCHEMA))
    item = schema["properties"]["tasks"]["items"]
    item["properties"]["file"] = {"type": ["string", "null"], "enum": [*lists, None]}
    item["properties"]["fileReason"] = {"type": "string",
                                        "description": "For an [Inbox] task: why it fits that list, or why none clearly does."}
    item["required"] = [*item["required"], "file", "fileReason"]
    return schema


def fileable(task: dict) -> bool:
    """An Inbox task the owner hasn't sent back to the Inbox."""
    return bool(task.get("inbox")) and task.get("movedBy") != "owner"


SYSTEM = "You order one person's open to-do tasks for the focus page that shows them their next three."

MOVE_RULES = {
    "off": 'move is always "none".',
    "one-tier": 'Use "up" or "down" only when a task is clearly in the wrong tier, at most 3 moves in all.',
    "free": 'Use "up" or "down" when a task is clearly in the wrong tier.',
}


def rank_config() -> StepConfig:
    """RANK_* settings, each falling back to its EXTRACT_* one (N20). With
    Anthropic the model defaults to Opus 5.5 (N7); other providers have no
    default, so they reuse EXTRACT_MODEL."""
    def get(name: str) -> str:
        return _env(f"RANK_{name}") or _env(f"EXTRACT_{name}")

    provider = (get("PROVIDER") or "anthropic").lower()
    model = _env("RANK_MODEL") or (DEFAULT_MODEL if provider == "anthropic" else get("MODEL"))
    return StepConfig("rank", provider, model, get("API_KEY"), get("BASE_URL"), max_tokens=16000, timeout_s=300.0)


def base_tier(task: dict) -> int:
    """The task's tier before any nudge, as focus.js computes it: 0 soon, 1 starred, 2 rest."""
    due_in = task.get("dueIn")
    return 0 if due_in is not None and due_in <= 3 else 1 if task.get("starred") else 2


def _file_rule(lists: tuple[str, ...]) -> str:
    if not lists:
        return ""
    return ("Tasks whose list is marked [Inbox] may be filed: set file to the one list below that clearly fits "
            "from the task's own words, and fileReason to why (under 12 words). If no list clearly fits, or "
            "more than one might, file is null and fileReason says why not. Every other task: file null, "
            "fileReason empty.\nLists: " + ", ".join(json.dumps(name) for name in lists) + "\n\n")


def build_prompt(tasks: list[dict], today: str, priorities: str | None, mode: str,
                 lists: tuple[str, ...] = ()) -> str:
    lines = []
    for n, t in enumerate(tasks, 1):
        due = t.get("due") or "-"
        where = " / ".join(x for x in (t.get("listTitle"), t.get("boardTitle")) if x)
        if lists and fileable(t):
            where += " [Inbox]"
        lines.append(f"{n} | {TIERS[base_tier(t)]} | {due} | {where} | {t.get('text', '')}")
    notes = (f"<priorities>\n{priorities}\n</priorities>\nThe owner's own note on what matters now; "
             "weigh it.\n\n") if priorities else ""
    return (
        f"Today is {today}.\n\n"
        "The focus page lists tasks by tier, top first: soon (due within 3 days), starred, rest. Overdue, "
        "due-today and hand-placed tasks are already above all of these and are not listed. Within a tier, "
        "a higher score comes first.\n\n"
        "For every task give its number n, a score from 0 to 100 (how much it matters to do soon), "
        "a reason (one short line, under 15 words) and a move: \"up\" or \"down\" one tier, or \"none\". "
        f"{MOVE_RULES[mode]}\n\n{_file_rule(lists)}{notes}"
        "Tasks (n | tier | due | list / board | title):\n" + "\n".join(lines)
    )


def plan(tasks: list[dict], ranking: Ranking, mode: str) -> list[dict]:
    """The PUT /api/tasks/rank body from the model's answer: unknown or repeated
    numbers dropped, scores clamped to 0-100, and moves kept only when they
    change the tier and the mode allows them (one-tier: the first 3)."""
    ranks, seen, moves = [], set(), 0
    for a in ranking.tasks:
        if not 1 <= a.n <= len(tasks) or a.n in seen:
            continue
        seen.add(a.n)
        t = tasks[a.n - 1]
        nudge = {"up": 1, "down": -1}.get(a.move, 0)
        if nudge and (mode == "off" or not 0 <= base_tier(t) - nudge <= 2
                      or (mode == "one-tier" and moves >= NUDGE_CAP)):
            nudge = 0
        moves += bool(nudge)
        reason = " ".join(a.reason.split())[:REASON_MAX] or None
        ranks.append({"id": t["id"], "rankScore": round(min(100.0, max(0.0, a.score)), 1),
                      "rankReason": reason, "rankNudge": nudge})
    return ranks


def plan_moves(tasks: list[dict], ranking: Ranking, lists: dict[str, str]) -> tuple[list[dict], list[dict]]:
    """The moves to send (fileable tasks only, a Filing list's title only, any
    case, each task once, at most FILE_CAP) and a decision for every fileable
    task sent: `{id, text, list, reason}`, `list` None when it stays."""
    if not lists:
        return [], []  # nothing to file into: the log says so once
    by_title = {title.lower(): (title, list_id) for title, list_id in lists.items()}
    answers = {}
    for a in ranking.tasks:
        answers.setdefault(a.n, a)
    moves, decisions = [], []
    for n, t in enumerate(tasks, 1):
        if not fileable(t):
            continue
        a = answers.get(n)
        reason = " ".join(a.fileReason.split())[:REASON_MAX] if a else ""
        named = (a.file or "").strip() if a else ""
        title, list_id = by_title.get(named.lower(), (None, None))
        if not a:
            title, reason = None, "the model gave no answer for it"
        elif named and not list_id:
            reason = f"{named} isn't a Filing list"
        elif list_id and list_id == t.get("listId"):
            title, reason = None, "it is in that list already"
        elif list_id and len(moves) >= FILE_CAP:
            title, reason = None, f"the nightly limit of {FILE_CAP} moves was reached"
        if title:
            moves.append({"id": t["id"], "listId": list_id, "reason": reason})
        decisions.append({"id": t["id"], "text": t.get("text", ""), "list": title, "reason": reason or "no reason given"})
    return moves, decisions


def log_lines(decisions: list[dict], note: str = "") -> list[str]:
    """One line per decision for the filing log, or the note when there are none."""
    if not decisions:
        return [note or "No Inbox tasks to file."]
    return [f'Moved "{d["text"]}" to {d["list"]}: {d["reason"]}' if d["list"]
            else f'Left "{d["text"]}" in the Inbox: {d["reason"]}' for d in decisions]


def log_card(runs: list[dict]) -> dict:
    """The Filing log card's data: the runs (newest first) plus the TipTap doc and
    plain text the board shows and searches. Document cards keep both."""
    def node(kind, text, **attrs):
        return {"type": kind, **({"attrs": attrs} if attrs else {}), "content": [{"type": "text", "text": text}]}
    content, text = [], []
    for r in runs:
        content.append(node("heading", r["at"], level=2))
        content += [node("paragraph", line) for line in r["lines"]]
        text += [r["at"], *r["lines"], ""]
    return {"title": LOG_TITLE, "runs": runs, "doc": {"type": "doc", "content": content},
            "text": "\n".join(text).strip()}


def stamp(tz: str) -> str:
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    return datetime.now(zone).strftime("%Y-%m-%d %H:%M %Z")


def write_log(client: TasksClient, entry: dict) -> None:
    """Adds `entry` on top of the Filing log card on Home (made on first use),
    keeping the last LOG_RUNS. Only a document card titled "Filing log" whose
    data has `runs` counts as the log, so an owner's own document is never overwritten."""
    card, home = client.filing_log(LOG_TITLE)
    runs = card["data"]["runs"] if card else []
    data = log_card([entry, *runs][:LOG_RUNS])
    if card:
        client.update_item(card["id"], data)
    else:
        client.add_card(home, "document", data)


def predict(tasks: list[dict], ranks: list[dict]) -> list[dict]:
    """The focus order after writing `ranks`, mirroring focus.js for the ranked
    tiers; the fixed tasks keep their place on top. For the dry run."""
    by_id = {r["id"]: r for r in ranks}

    def key(t):
        r = by_id.get(t["id"])
        tier = min(2, max(0, base_tier(t) - (r["rankNudge"] if r else 0)))
        score = r["rankScore"] if r else t.get("rankScore")
        return (tier, score is None, -(score or 0), (t.get("dueIn") or 0) if tier == 0 else 0,
                t.get("createdAt") or 0)

    fixed = [t for t in tasks if t.get("tier") not in TIERS]
    return fixed + sorted((t for t in tasks if t.get("tier") in TIERS), key=key)


def top3(tasks: list[dict]) -> list[str]:
    return [t.get("text", "") for t in tasks[:3]]


def cost(model: str, input_tokens: int | None, output_tokens: int | None) -> float | None:
    price = PRICES.get(model)
    if not price or input_tokens is None or output_tokens is None:
        return None
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1e6, 4)


def run(cfg: StepConfig, client: TasksClient, mode: str, *, dry_run: bool = False, complete=complete_json,
        tz: str = "UTC") -> int:
    """One ranking pass. Returns 0 on success, 1 when anything failed (nothing
    written, or the ranking written but not its filing log entry)."""
    try:
        view = client.focus()
        tasks = [t for t in view.get("tasks", []) if t.get("tier") in TIERS][:MAX_TASKS]
        before = top3(view.get("tasks", []))
        if not tasks:
            log("rank.skip", reason="no tasks to rank", before=before)
            entry = {"at": stamp(tz), "lines": log_lines([], "No tasks to rank, so none to file.")}
            if dry_run:
                print(f"Filing log entry ({entry['at']}):", *entry["lines"], sep="\n  ")
            else:
                write_log(client, entry)
            return 0
        lists = client.filing_lists() if any(fileable(t) for t in tasks) else {}
        prompt = build_prompt(tasks, view.get("today", ""), client.priorities(), mode, tuple(lists))
        result = complete(cfg, SYSTEM, prompt, Ranking, build_schema(tuple(lists)))
        ranks = plan(tasks, result.data, mode)
        if not ranks:
            raise LLMError("the model ranked none of the tasks")
        moves, decisions = plan_moves(tasks, result.data, lists)
        note = "" if lists or not any(fileable(t) for t in tasks) else "No list is labelled Filing."
        if dry_run:
            after = top3(predict(view["tasks"], ranks))
            titles = {t["id"]: t.get("text", "") for t in tasks}
            for r in ranks:
                move = {1: " up", -1: " down", 0: ""}[r["rankNudge"]]
                print(f"{r['rankScore']:5.1f}{move:5} {titles[r['id']]} - {r['rankReason'] or ''}")
            names = {list_id: title for title, list_id in lists.items()}
            for m in moves:
                print(f"\u2192 {names[m['listId']]}: {titles[m['id']]} - {m['reason']}")
            print(f"Filing log entry ({stamp(tz)}):", *log_lines(decisions, note), sep="\n  ")
        else:
            written = client.write_ranks(ranks, moves)
            gone = set(written.get("movesSkipped") or [])  # moved or deleted since the focus view was read
            for d in decisions:
                if d["id"] in gone:
                    d.update(list=None, reason="it left the Inbox before it could be moved")
            try:
                write_log(client, {"at": stamp(tz), "lines": log_lines(decisions, note)})
            except TaskAPIError as e:
                log("rank.log_failed", error=str(e), filed=len(moves) - len(gone))
                return 1
            try:
                after = top3(client.focus(limit="3").get("tasks", []))
            except (TaskAPIError, ValueError) as e:  # written already: report it as done
                after = None
                log("rank.after_unavailable", error=str(e))
    except (LLMError, TaskAPIError, ValueError) as e:
        log("rank.failed", dry_run=dry_run, error=str(e))
        return 1
    log("rank.done", dry_run=dry_run, provider=result.provider, model=result.model, tasks=len(tasks),
        ranked=len(ranks), moves=sum(1 for r in ranks if r["rankNudge"]), filed=len(moves), input_tokens=result.input_tokens,
        output_tokens=result.output_tokens, cost_usd=cost(result.model, result.input_tokens, result.output_tokens),
        before=before, after=after)
    return 0


def next_run(now: datetime) -> datetime:
    """The next 03:00 after `now`, in now's time zone."""
    at = now.replace(hour=3, minute=0, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def serve(cfg: StepConfig, client: TasksClient, mode: str, tz: str) -> None:
    zone = ZoneInfo(tz)
    while True:
        at = next_run(datetime.now(zone))
        log("rank.next", at=at.isoformat())
        # Short sleeps, so a suspended host or clock change can't push the run a day.
        while (left := at.timestamp() - time.time()) > 0:
            time.sleep(min(left, 600))
        run(cfg, client, mode, tz=tz)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m ingest.rank", description="Nightly focus ranking.")
    p.add_argument("--dry-run", action="store_true", help="rank once now and print the result; write nothing")
    args = p.parse_args(argv)
    mode = _env("RANK_NUDGE", "one-tier").lower()
    if mode not in MOVE_RULES:
        print("RANK_NUDGE must be off, one-tier or free", file=sys.stderr)
        return 2
    settings = Settings.from_env()
    cfg, client = rank_config(), TasksClient(settings.app_url, settings.task_token)
    if args.dry_run:
        return run(cfg, client, mode, dry_run=True, tz=settings.tz)
    if _env("RANK_SCHEDULE", "off").lower() != "on":
        log("rank.schedule_off", hint="run --dry-run, then set RANK_SCHEDULE=on to rank nightly at 03:00")
        return 0
    try:
        ZoneInfo(settings.tz)
    except (ZoneInfoNotFoundError, ValueError):
        # Exit 0, so restart: on-failure doesn't loop; the app needs a valid TASK_TZ too.
        log("rank.bad_tz", error=f"TASK_TZ {settings.tz!r} is not a time zone; not scheduling")
        return 0
    serve(cfg, client, mode, settings.tz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
