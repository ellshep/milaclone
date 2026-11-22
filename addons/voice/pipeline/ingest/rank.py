"""The nightly ranking (next-phases M2.3): orders open tasks for the focus page.

    python -m ingest.rank             # the Compose service: 03:00 in TASK_TZ, if RANK_SCHEDULE=on
    python -m ingest.rank --dry-run   # rank once, print what would be written, write nothing

The app's four bands (focus.js, focus-redesign R8) stay in charge: due-now
tasks and tasks the owner placed (yours, or sent to the bottom) are never sent
or touched. The model scores the "everything else" band, the only one its
scores order (R9), with a one-line reason. It reads the Home note headed
"Focus priorities" too. Everything goes in one PUT /api/tasks/rank, written
only when every step worked, so any failure leaves the order as it was. There
is no stale rule yet (N22).

Nightly filing (M3.3): Inbox tasks among those sent may be filed into the one
list labelled Filing that clearly fits, at most FILE_CAP a night, with a reason.
The moves ride in the same PUT (movedBy "ranker"). Only tasks sent for ranking
are considered, so due-now and placed Inbox tasks never are,
and at most FILE_CANDIDATES of them. A task whose last move was anyone's but the
ranker's (sent back to the Inbox through the API, an agent or the owner) is
never filed again. Each run then writes the "Filing log" document card on Home
through the board's HTTP API: the run's time and, for every Inbox task it
considered, moved where or left, and why. Newest run first, the last LOG_RUNS kept.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel

from .config import Settings, StepConfig, _env
from .llm import LLMError, complete_json
from .logs import log
from .tasks_client import TaskAPIError, TasksClient

DEFAULT_MODEL = "claude-opus-5-5"  # N7, at the low effort llm.py always asks for
PRICES = {"claude-opus-5-5": (4.0, 20.0)}  # USD per million input / output tokens
BAND = "rest"  # the focus.js tier (band) the ranking orders: everything else
# The first this many rankable tasks (in the current order) go to the model, so
# the answer fits in max_tokens; the rest keep their last score.
MAX_TASKS = 200
REASON_MAX = 300
FILE_CAP = 10  # Inbox tasks filed a night, at most (M3.3)
# Inbox tasks asked about a night: each filing answer costs ~25 output tokens on
# top of ~35 per ranked task, so 200 tasks plus 40 candidates stay near 8k of max_tokens' 16k.
FILE_CANDIDATES = 40
LOG_TITLE = "Filing log"
LOG_RUNS = 30  # runs the filing log keeps


class RankedTask(BaseModel):
    n: int
    score: float
    reason: str


class Filing(BaseModel):
    n: int  # an [Inbox] task's number
    list: str | None  # the Filing list that clearly fits, or None
    reason: str


class Ranking(BaseModel):
    tasks: list[RankedTask]
    filing: list[Filing] = []


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
                },
                "required": ["n", "score", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["tasks"],
    "additionalProperties": False,
}


def build_schema(lists: tuple[str, ...] = (), candidates: tuple[int, ...] = ()) -> dict:
    """The answer's schema. With Filing lists and Inbox candidates it adds a
    `filing` array whose `n` can only be a candidate's number."""
    if not lists or not candidates:
        return SCHEMA
    schema = json.loads(json.dumps(SCHEMA))
    schema["properties"]["filing"] = {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "n": {"type": "integer", "enum": list(candidates)},
                "list": {"type": ["string", "null"], "enum": [*lists, None]},
                "reason": {"type": "string", "description": "Under 10 words: why it fits, or why none does."},
            },
            "required": ["n", "list", "reason"],
            "additionalProperties": False,
        },
    }
    schema["required"] = ["tasks", "filing"]
    return schema


def fileable(task: dict) -> bool:
    """An Inbox task nobody but the ranker has moved: any other move back to the
    Inbox (the API, an agent, the owner) means it stays. The app checks the same."""
    return bool(task.get("inbox")) and task.get("movedBy") in (None, "ranker")


def candidates(tasks: list[dict]) -> tuple[int, ...]:
    """The numbers (1-based) of the tasks asked about filing tonight."""
    return tuple(n for n, t in enumerate(tasks, 1) if fileable(t))[:FILE_CANDIDATES]


SYSTEM = "You order one person's open to-do tasks for the focus page that shows them their next three."


def rank_config() -> StepConfig:
    """RANK_* settings, each falling back to its EXTRACT_* one (N20). With
    Anthropic the model defaults to Opus 5.5 (N7); other providers have no
    default, so they reuse EXTRACT_MODEL."""
    def get(name: str) -> str:
        return _env(f"RANK_{name}") or _env(f"EXTRACT_{name}")

    provider = (get("PROVIDER") or "anthropic").lower()
    model = _env("RANK_MODEL") or (DEFAULT_MODEL if provider == "anthropic" else get("MODEL"))
    return StepConfig("rank", provider, model, get("API_KEY"), get("BASE_URL"), max_tokens=16000, timeout_s=300.0)


def _file_rule(lists: tuple[str, ...], cands: tuple[int, ...]) -> str:
    if not lists or not cands:
        return ""
    return ("Tasks marked [Inbox] may be filed. Also give a filing entry for each of them: its number n, "
            "list = the one list below that clearly fits from the task's own words, or null if none does or "
            "more than one might, and a reason under 10 words.\nLists: "
            + ", ".join(json.dumps(name) for name in lists) + "\n\n")


def build_prompt(tasks: list[dict], today: str, priorities: str | None, lists: tuple[str, ...] = ()) -> str:
    lines = []
    cands = set(candidates(tasks)) if lists else set()
    for n, t in enumerate(tasks, 1):
        due = t.get("due") or "-"
        where = " / ".join(x for x in (t.get("listTitle"), t.get("boardTitle")) if x)
        if n in cands:
            where += " [Inbox]"
        star = "starred" if t.get("starred") else "-"
        lines.append(f"{n} | {due} | {star} | {where} | {t.get('text', '')}")
    notes = (f"<priorities>\n{priorities}\n</priorities>\nThe owner's own note on what matters now; "
             "weigh it.\n\n") if priorities else ""
    return (
        f"Today is {today}.\n\n"
        "The focus page shows tasks due now (overdue or due today) first, then the ones the owner placed "
        "by hand, then the tasks below, then the ones the owner sent to the bottom. Only the tasks below are "
        "listed, and your scores alone order them: a higher score comes first.\n\n"
        "For every task give its number n, a score from 0 to 100 (how much it matters to do soon) "
        f"and a reason (one short line, under 15 words).\n\n{_file_rule(lists, tuple(cands))}{notes}"
        "Tasks (n | due | starred | list / board | title):\n" + "\n".join(lines)
    )


def plan(tasks: list[dict], ranking: Ranking) -> list[dict]:
    """The PUT /api/tasks/rank body from the model's answer: unknown or repeated
    numbers dropped, scores clamped to 0-100."""
    ranks, seen = [], set()
    for a in ranking.tasks:
        if not 1 <= a.n <= len(tasks) or a.n in seen:
            continue
        seen.add(a.n)
        reason = " ".join(a.reason.split())[:REASON_MAX] or None
        ranks.append({"id": tasks[a.n - 1]["id"], "score": round(min(100.0, max(0.0, a.score)), 1), "reason": reason})
    return ranks


def plan_moves(tasks: list[dict], ranking: Ranking, lists: dict[str, str]) -> tuple[list[dict], list[dict]]:
    """The moves to send (candidates only, a Filing list's title only, any case,
    each task once, at most FILE_CAP) and a decision for every candidate:
    `{id, text, list, reason}`, `list` None when it stays."""
    if not lists:
        return [], []  # nothing to file into: the log says so once
    by_title = {title.lower(): (title, list_id) for title, list_id in lists.items()}
    answers = {}
    for a in ranking.filing:
        answers.setdefault(a.n, a)
    moves, decisions = [], []
    for n in candidates(tasks):
        t, a = tasks[n - 1], answers.get(n)
        reason = " ".join(a.reason.split())[:REASON_MAX] if a else ""
        named = (a.list or "").strip() if a else ""
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

    def line(d):
        if d.get("skipped"):
            return f'Not moved "{d["text"]}": {d["reason"]}'
        if d["list"]:
            return f'Moved "{d["text"]}" to {d["list"]}: {d["reason"]}'
        return f'Left "{d["text"]}" in the Inbox: {d["reason"]}'
    return [line(d) for d in decisions]


def _node_text(node: dict) -> str:
    return "".join(c.get("text", "") for c in node.get("content") or [])


def log_runs(doc: dict | None) -> list[dict]:
    """The runs back out of the log's doc: each level-2 heading starts a run, the
    paragraphs under it are its lines. The doc is the only copy (no separate runs)."""
    runs = []
    for node in (doc or {}).get("content") or []:
        if node.get("type") == "heading":
            runs.append({"at": _node_text(node), "lines": []})
        elif node.get("type") == "paragraph" and runs and _node_text(node):
            runs[-1]["lines"].append(_node_text(node))
    return runs


def log_card(runs: list[dict]) -> dict:
    """The Filing log card's data: the TipTap doc the board shows, and its plain
    text for the snippet, search and export (a document card keeps both itself).
    `filingLog` marks the card as the ranker's."""
    def node(kind, text, **attrs):  # TipTap rejects an empty text node (an owner-blanked heading)
        return {"type": kind, **({"attrs": attrs} if attrs else {}),
                **({"content": [{"type": "text", "text": text}]} if text else {})}
    content, text = [], []
    for r in runs:
        content.append(node("heading", r["at"], level=2))
        content += [node("paragraph", line) for line in r["lines"]]
        text += [r["at"], *r["lines"], ""]
    return {"title": LOG_TITLE, "filingLog": True, "doc": {"type": "doc", "content": content},
            "text": "\n".join(text).strip()}


def stamp(tz: str) -> str:
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo("UTC")
    return datetime.now(zone).strftime("%Y-%m-%d %H:%M %Z")


def write_log(client: TasksClient, entry: dict) -> None:
    """Adds `entry` on top of the Filing log card on Home (made on first use),
    keeping the last LOG_RUNS. Only a document card titled "Filing log" marked
    `filingLog` counts as the log, so an owner's own document is never overwritten."""
    card, home = client.filing_log(LOG_TITLE)
    runs = log_runs(card["data"].get("doc")) if card else []
    data = log_card([entry, *runs][:LOG_RUNS])
    if card:
        client.update_item(card["id"], data)
    else:
        client.add_card(home, "document", data)


def predict(tasks: list[dict], ranks: list[dict]) -> list[dict]:
    """The focus order after writing `ranks`, mirroring focus.js for the ranked
    band; the bands above and below it keep their place. For the dry run."""
    by_id = {r["id"]: r for r in ranks}

    def key(t):
        r = by_id.get(t["id"])
        score = r["score"] if r else (t.get("rank") or {}).get("score")
        due_in = t.get("dueIn")
        return (score is None, -(score or 0), due_in is None, due_in or 0, not t.get("starred"),
                t.get("createdAt") or 0)

    above = [t for t in tasks if t.get("tier") not in (BAND, "bottom")]
    below = [t for t in tasks if t.get("tier") == "bottom"]
    return above + sorted((t for t in tasks if t.get("tier") == BAND), key=key) + below


def top3(tasks: list[dict]) -> list[str]:
    return [t.get("text", "") for t in tasks[:3]]


def cost(model: str, input_tokens: int | None, output_tokens: int | None) -> float | None:
    price = PRICES.get(model)
    if not price or input_tokens is None or output_tokens is None:
        return None
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1e6, 4)


def run(cfg: StepConfig, client: TasksClient, *, dry_run: bool = False, complete=complete_json,
        tz: str = "UTC") -> int:
    """One ranking pass. Returns 0 on success, 1 when anything failed (nothing
    written, or the ranking written but not its filing log entry). The nightly
    service logs either and carries on; only --dry-run exits with it."""
    try:
        view = client.focus()
        tasks = [t for t in view.get("tasks", []) if t.get("tier") == BAND][:MAX_TASKS]
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
        prompt = build_prompt(tasks, view.get("today", ""), client.priorities(), tuple(lists))
        result = complete(cfg, SYSTEM, prompt, Ranking, build_schema(tuple(lists), candidates(tasks)))
        ranks = plan(tasks, result.data)
        if not ranks:
            raise LLMError("the model ranked none of the tasks")
        moves, decisions = plan_moves(tasks, result.data, lists)
        note = "" if lists or not any(fileable(t) for t in tasks) else "No list is labelled Filing."
        if dry_run:
            after = top3(predict(view["tasks"], ranks))
            titles = {t["id"]: t.get("text", "") for t in tasks}
            for r in ranks:
                print(f"{r['score']:5.1f} {titles[r['id']]} - {r['reason'] or ''}")
            names = {list_id: title for title, list_id in lists.items()}
            for m in moves:
                print(f"\u2192 {names[m['listId']]}: {titles[m['id']]} - {m['reason']}")
            print(f"Filing log entry ({stamp(tz)}):", *log_lines(decisions, note), sep="\n  ")
        else:
            written = client.write_ranks(ranks, moves)
            # The app refuses a move whose task changed since the focus view was read, and says why.
            gone = {s.get("id"): s.get("reason") or "skipped" for s in written.get("movesSkipped") or []}
            for d in decisions:
                if d["id"] in gone and d["list"]:
                    d.update(skipped=True, reason=gone[d["id"]])
            try:
                write_log(client, {"at": stamp(tz), "lines": log_lines(decisions, note)})
            except TaskAPIError as e:  # the moves landed but aren't logged: say which, for the owner
                log("rank.log_failed", error=str(e), moves=[f'{d["text"]} -> {d["list"]}' for d in decisions
                                                            if d["list"] and not d.get("skipped")])
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
        ranked=len(ranks), filed=len(moves), input_tokens=result.input_tokens,
        output_tokens=result.output_tokens, cost_usd=cost(result.model, result.input_tokens, result.output_tokens),
        before=before, after=after)
    return 0


def next_run(now: datetime) -> datetime:
    """The next 03:00 after `now`, in now's time zone."""
    at = now.replace(hour=3, minute=0, second=0, microsecond=0)
    return at if at > now else at + timedelta(days=1)


def serve(cfg: StepConfig, client: TasksClient, tz: str) -> None:
    zone = ZoneInfo(tz)
    while True:
        at = next_run(datetime.now(zone))
        log("rank.next", at=at.isoformat())
        # Short sleeps, so a suspended host or clock change can't push the run a day.
        while (left := at.timestamp() - time.time()) > 0:
            time.sleep(min(left, 600))
        run(cfg, client, tz=tz)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m ingest.rank", description="Nightly focus ranking.")
    p.add_argument("--dry-run", action="store_true", help="rank once now and print the result; write nothing")
    args = p.parse_args(argv)
    settings = Settings.from_env()
    cfg, client = rank_config(), TasksClient(settings.app_url, settings.task_token)
    if args.dry_run:
        return run(cfg, client, dry_run=True, tz=settings.tz)
    if _env("RANK_SCHEDULE", "off").lower() != "on":
        log("rank.schedule_off", hint="run --dry-run, then set RANK_SCHEDULE=on to rank nightly at 03:00")
        return 0
    try:
        ZoneInfo(settings.tz)
    except (ZoneInfoNotFoundError, ValueError):
        # Exit 0, so restart: on-failure doesn't loop; the app needs a valid TASK_TZ too.
        log("rank.bad_tz", error=f"TASK_TZ {settings.tz!r} is not a time zone; not scheduling")
        return 0
    serve(cfg, client, settings.tz)
    return 0


if __name__ == "__main__":
    sys.exit(main())
