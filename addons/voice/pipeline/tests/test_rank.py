import json
from datetime import datetime
from zoneinfo import ZoneInfo

import httpx
import pytest

from ingest import rank
from ingest.config import StepConfig
from ingest.llm import complete_json
from ingest.tasks_client import TaskAPIError, TasksClient

FAKE = StepConfig("rank", "fake", "fake")


def task(id, tier, **f):
    return {"id": id, "text": id.title(), "tier": tier, "dueIn": None, "createdAt": 1, "listTitle": "L", **f}


class FakeClient:
    def __init__(self, tasks, priorities=None, lists=None):
        self.tasks, self.prio, self.lists = tasks, priorities, lists or {}
        self.writes, self.moves, self.fail = [], [], None
        self.list_reads = 0
        self.log = None  # the Filing log card on Home
        self.gone = []  # move ids the app reports as skipped

    def filing_lists(self):
        self.list_reads += 1
        return self.lists

    def focus(self, limit="all"):
        if self.fail == "focus" or (self.fail == "after" and limit != "all"):
            raise TaskAPIError("task API HTTP 500")
        return {"today": "2026-11-22", "tasks": self.tasks if limit == "all" else self.tasks[:int(limit)]}

    def priorities(self):
        if self.fail == "priorities":
            raise TaskAPIError("task API unreachable")
        return self.prio

    def write_ranks(self, ranks, moves=None):
        self.writes.append(ranks)
        self.moves.append(moves)
        return {"ranked": len(ranks), "skipped": [], "moved": len(moves or []), "movesSkipped": self.gone}

    def filing_log(self, title):
        return self.log, "c_home"

    def update_item(self, item_id, data):
        if self.fail == "log":
            raise TaskAPIError("board HTTP 500")
        self.log["data"] = data

    def add_card(self, canvas_id, kind, data):
        if self.fail == "log":
            raise TaskAPIError("board HTTP 500")
        self.log = {"id": "i_log", "type": kind, "canvasId": canvas_id, "data": data}


def answer(monkeypatch, *rows):
    monkeypatch.setenv("FAKE_LLM_RESPONSE", json.dumps({"tasks": [
        {"n": n, "score": s, "reason": r, "move": m} for n, s, r, m in rows]}))


def capture():
    prompts = []

    def complete(cfg, system, prompt, *a, **k):
        prompts.append(prompt)
        return complete_json(cfg, system, prompt, *a, **k)
    return prompts, complete


BOARD = [
    task("late", "overdue", dueIn=-2, due="2026-11-20"),
    task("placed", "placed", focusOrder=1),
    task("soon", "soon", dueIn=2, due="2026-11-24"),
    task("chore", "rest"),
    task("big", "starred", starred=True, createdAt=5),
]


def test_writes_scores_for_ranked_tiers_only_and_sends_priorities(monkeypatch):
    client = FakeClient(BOARD, priorities="Focus priorities\nHealth first")
    answer(monkeypatch, (1, 40, "Due Tuesday", "none"), (3, 90, "  Unblocks\n everything ", "up"),
           (2, 120, "Small", "none"), (9, 50, "no such task", "none"), (3, 10, "repeat", "none"))
    prompts, complete = capture()
    assert rank.run(FAKE, client, "one-tier", complete=complete) == 0
    assert client.writes == [[
        {"id": "soon", "rankScore": 40.0, "rankReason": "Due Tuesday", "rankNudge": 0},
        {"id": "big", "rankScore": 90.0, "rankReason": "Unblocks everything", "rankNudge": 1},
        {"id": "chore", "rankScore": 100.0, "rankReason": "Small", "rankNudge": 0},
    ]]
    prompt = prompts[0]
    assert "Health first" in prompt and "| Big" in prompt
    assert "Late" not in prompt and "Placed" not in prompt  # fixed and placed tasks are never sent (N6)


def test_moves_are_capped_and_never_leave_the_tiers(monkeypatch):
    tasks = [task("soon", "soon", dueIn=1)] + [task(f"t{i}", "rest") for i in range(6)]
    answer(monkeypatch, *[(n, 50, "r", "up") for n in range(1, 8)])
    nudges = {}
    for mode in ("one-tier", "free", "off"):
        client = FakeClient(tasks)
        assert rank.run(FAKE, client, mode) == 0
        nudges[mode] = [r["rankNudge"] for r in client.writes[0]]
    assert nudges["one-tier"] == [0, 1, 1, 1, 0, 0, 0]  # "up" from soon can't move; then the first 3
    assert nudges["free"] == [0, 1, 1, 1, 1, 1, 1]
    assert nudges["off"] == [0] * 7
    answer(monkeypatch, (1, 50, "r", "down"))
    client = FakeClient([task("rest", "rest")])
    rank.run(FAKE, client, "free")
    assert client.writes[0][0]["rankNudge"] == 0  # already the bottom tier


@pytest.mark.parametrize("fail", ["model", "empty", "priorities", "focus"])
def test_any_failure_writes_nothing(monkeypatch, fail):
    client = FakeClient(BOARD)
    answer(monkeypatch, (9, 50, "out of range", "none"))
    if fail == "model":
        monkeypatch.setenv("FAKE_LLM_RESPONSE", "not json")
    elif fail in ("priorities", "focus"):
        client.fail = fail
    assert rank.run(FAKE, client, "one-tier") == 1
    assert client.writes == []


def test_dry_run_prints_and_writes_nothing(monkeypatch, capsys):
    client = FakeClient(BOARD)
    answer(monkeypatch, (1, 10, "Can wait", "none"), (2, 30, "Meh", "none"), (3, 90, "Matters", "up"))
    assert rank.run(FAKE, client, "one-tier", dry_run=True) == 0
    assert client.writes == []
    out = capsys.readouterr().out
    assert " 90.0 up   Big - Matters" in out
    done = json.loads([line for line in out.splitlines() if '"rank.done"' in line][0])
    assert done["before"] == ["Late", "Placed", "Soon"]
    assert done["after"] == ["Late", "Placed", "Big"]  # nudged up into soon, above Soon's score
    assert done["dry_run"] is True


def files(monkeypatch, *rows):
    """A ranking answer for len(rows) tasks; row i (1-based) is task i's filing
    answer (list or None, reason), or None for no filing answer."""
    monkeypatch.setenv("FAKE_LLM_RESPONSE", json.dumps({
        "tasks": [{"n": n, "score": 50, "reason": "r", "move": "none"} for n in range(1, len(rows) + 1)],
        "filing": [{"n": n, "list": f[0], "reason": f[1]} for n, f in enumerate(rows, 1) if f]}))


LISTS = {"Garden": "i_garden", "Errands": "i_errands"}


def test_files_inbox_tasks_into_one_named_filing_list(monkeypatch):
    tasks = [task("seeds", "rest", inbox=True), task("shears", "rest", inbox=True, movedBy="api"),
             task("ink", "rest", listId="i_work"), task("bins", "rest", inbox=True),
             task("milk", "rest", inbox=True), task("rake", "rest", inbox=True, listId="i_garden")]
    client = FakeClient(tasks, lists=LISTS)
    files(monkeypatch, ("garden", "  Garden  shopping "), ("Garden", "sent back"), ("Errands", "not Inbox"),
          ("Garage", "no such list"), None, ("Garden", "already there"))
    prompts, complete = capture()
    assert rank.run(FAKE, client, "one-tier", complete=complete) == 0
    assert client.moves == [[{"id": "seeds", "listId": "i_garden", "reason": "Garden shopping"}]]
    prompt = prompts[0]
    assert 'Lists: "Garden", "Errands"' in prompt
    assert "| L [Inbox] | Seeds" in prompt and "| L | Shears" in prompt and "| L | Ink" in prompt
    assert "| L [Inbox] | Bins" in prompt and "| L [Inbox] | Rake" in prompt


def test_the_schema_asks_filing_only_for_inbox_candidates():
    tasks = [task("a", "rest", inbox=True), task("b", "rest"), task("c", "rest", inbox=True, movedBy="api"),
             task("d", "rest", inbox=True, movedBy="ranker")]
    assert rank.candidates(tasks) == (1, 4)  # sent back through the API: never again
    schema = rank.build_schema(("Garden",), rank.candidates(tasks))
    assert schema["properties"]["tasks"] == rank.SCHEMA["properties"]["tasks"]  # ranking answers stay lean
    filing = schema["properties"]["filing"]["items"]["properties"]
    assert filing["n"]["enum"] == [1, 4] and filing["list"]["enum"] == ["Garden", None]
    assert schema["required"] == ["tasks", "filing"]
    assert rank.build_schema(("Garden",), ()) is rank.SCHEMA
    many = [task(f"t{i}", "rest", inbox=True) for i in range(rank.FILE_CANDIDATES + 5)]
    assert len(rank.candidates(many)) == rank.FILE_CANDIDATES


def test_filing_is_capped_per_night(monkeypatch):
    tasks = [task(f"t{i}", "rest", inbox=True) for i in range(rank.FILE_CAP + 3)]
    client = FakeClient(tasks, lists=LISTS)
    files(monkeypatch, *[("Errands", "errand")] * len(tasks))
    assert rank.run(FAKE, client, "one-tier") == 0
    assert len(client.moves[0]) == rank.FILE_CAP


def test_no_inbox_tasks_means_no_filing(monkeypatch):
    client = FakeClient(BOARD, lists=LISTS)
    answer(monkeypatch, (1, 10, "a", "none"), (2, 20, "b", "none"), (3, 30, "c", "none"))
    prompts, complete = capture()
    assert rank.run(FAKE, client, "one-tier", complete=complete) == 0
    assert client.list_reads == 0 and client.moves == [[]]
    assert "[Inbox]" not in prompts[0] and "Lists:" not in prompts[0]
    assert rank.build_schema(()) is rank.SCHEMA


def test_dry_run_prints_planned_moves(monkeypatch, capsys):
    client = FakeClient([task("seeds", "rest", inbox=True)], lists=LISTS)
    files(monkeypatch, ("Garden", "Garden shopping"))
    assert rank.run(FAKE, client, "one-tier", dry_run=True) == 0
    assert client.writes == [] and client.moves == []
    out = capsys.readouterr().out
    assert "\u2192 Garden: Seeds - Garden shopping" in out
    assert json.loads([line for line in out.splitlines() if '"rank.done"' in line][0])["filed"] == 1


def test_only_the_first_max_tasks_are_sent(monkeypatch):
    monkeypatch.setattr(rank, "MAX_TASKS", 2)
    client = FakeClient(BOARD)
    answer(monkeypatch, (1, 10, "a", "none"), (2, 20, "b", "none"), (3, 30, "beyond the cap", "none"))
    prompts, complete = capture()
    assert rank.run(FAKE, client, "one-tier", complete=complete) == 0
    assert [r["id"] for r in client.writes[0]] == ["soon", "chore"]
    assert "| Big" not in prompts[0]


def test_a_failed_read_after_the_write_still_counts_as_done(monkeypatch, capsys):
    client = FakeClient(BOARD)
    client.fail = "after"
    answer(monkeypatch, (1, 10, "a", "none"))
    assert rank.run(FAKE, client, "one-tier") == 0
    assert len(client.writes) == 1
    out = capsys.readouterr().out
    assert '"rank.after_unavailable"' in out and '"rank.done"' in out and '"rank.failed"' not in out


def test_nothing_to_rank_writes_nothing_but_the_log_entry():
    client = FakeClient(BOARD[:2])
    assert rank.run(FAKE, client, "one-tier") == 0
    assert client.writes == []
    assert rank.log_runs(client.log["data"]["doc"])[0]["lines"] == ["No tasks to rank, so none to file."]


def test_filing_log_records_every_inbox_decision_newest_first_and_keeps_30(monkeypatch):
    tasks = [task("seeds", "rest", inbox=True), task("bins", "rest", inbox=True), task("ink", "rest")]
    client = FakeClient(tasks, lists=LISTS)
    files(monkeypatch, ("Garden", "Garden shopping"), (None, "  no list fits  "), None)
    assert rank.run(FAKE, client, "one-tier", tz="America/Chicago") == 0
    card = client.log
    assert (card["type"], card["canvasId"], card["data"]["title"]) == ("document", "c_home", "Filing log")
    first = rank.log_runs(card["data"]["doc"])[0]
    assert first["lines"] == ['Moved "Seeds" to Garden: Garden shopping', 'Left "Bins" in the Inbox: no list fits']
    assert "runs" not in card["data"] and card["data"]["filingLog"] is True  # the doc is the only copy
    assert first["at"].endswith(" CST") and len(first["at"]) == len("2026-11-22 03:00 CST")
    doc = card["data"]["doc"]["content"]
    assert [n["type"] for n in doc] == ["heading", "paragraph", "paragraph"]
    assert card["data"]["text"] == "\n".join([first["at"], *first["lines"]])

    files(monkeypatch, None, ("Errands", "a bin run"), None)
    assert rank.run(FAKE, client, "one-tier") == 0
    runs = rank.log_runs(client.log["data"]["doc"])
    assert [r["lines"] for r in runs] == [
        ['Left "Seeds" in the Inbox: the model gave no answer for it', 'Moved "Bins" to Errands: a bin run'],
        first["lines"]]
    for _ in range(29):  # 31 runs in all
        assert rank.run(FAKE, client, "one-tier") == 0
    runs = rank.log_runs(client.log["data"]["doc"])
    assert len(runs) == rank.LOG_RUNS and runs[-1]["lines"] != first["lines"]


def test_filing_log_explains_what_was_left(monkeypatch):
    tasks = [task(f"t{i}", "rest", inbox=True) for i in range(rank.FILE_CAP + 1)]
    tasks += [task("odd", "rest", inbox=True), task("mute", "rest", inbox=True)]
    client = FakeClient(tasks, lists=LISTS)
    files(monkeypatch, *[("Errands", "errand")] * (rank.FILE_CAP + 1), ("Garage", "a garage job"))
    client.gone = [{"id": "t0", "reason": "it left the Inbox before the move"}]
    assert rank.run(FAKE, client, "one-tier") == 0
    lines = rank.log_runs(client.log["data"]["doc"])[0]["lines"]
    assert lines[0] == 'Not moved "T0": it left the Inbox before the move'
    assert lines[rank.FILE_CAP] == f'Left "T{rank.FILE_CAP}" in the Inbox: the nightly limit of 10 moves was reached'
    assert lines[-2:] == ['Left "Odd" in the Inbox: Garage isn\'t a Filing list',
                          'Left "Mute" in the Inbox: the model gave no answer for it']


def test_no_filing_lists_is_logged(monkeypatch):
    client = FakeClient([task("seeds", "rest", inbox=True)])
    answer(monkeypatch, (1, 10, "a", "none"))
    assert rank.run(FAKE, client, "one-tier") == 0
    assert rank.log_runs(client.log["data"]["doc"])[0]["lines"] == ["No list is labelled Filing."]


def test_a_blanked_heading_never_becomes_an_empty_text_node(monkeypatch):
    client = FakeClient([task("seeds", "rest", inbox=True)], lists=LISTS)
    files(monkeypatch, ("Garden", "Garden shopping"))
    assert rank.run(FAKE, client, "one-tier") == 0
    client.log["data"]["doc"]["content"][0]["content"] = []  # the owner clears the run's heading
    assert rank.run(FAKE, client, "one-tier") == 0
    doc = client.log["data"]["doc"]["content"]
    texts = [c for n in doc for c in n.get("content", [])]
    assert texts and all(c["text"] for c in texts)
    assert [r["lines"] for r in rank.log_runs(client.log["data"]["doc"])] == [
        ['Moved "Seeds" to Garden: Garden shopping']] * 2


def test_dry_run_prints_the_log_entry_and_writes_no_log(monkeypatch, capsys):
    client = FakeClient([task("seeds", "rest", inbox=True)], lists=LISTS)
    files(monkeypatch, ("Garden", "Garden shopping"))
    assert rank.run(FAKE, client, "one-tier", dry_run=True) == 0
    assert client.log is None
    out = capsys.readouterr().out
    assert 'Filing log entry (' in out and '\n  Moved "Seeds" to Garden: Garden shopping' in out


def test_a_failed_log_write_is_reported(monkeypatch, capsys):
    client = FakeClient([task("seeds", "rest", inbox=True)], lists=LISTS)
    client.fail = "log"
    files(monkeypatch, ("Garden", "Garden shopping"))
    assert rank.run(FAKE, client, "one-tier") == 1
    assert len(client.writes) == 1  # the ranking and the move landed
    failed = [json.loads(line) for line in capsys.readouterr().out.splitlines() if '"rank.log_failed"' in line]
    assert failed[0]["moves"] == ["Seeds -> Garden"]


def test_rank_settings_fall_back_to_extract(monkeypatch):
    for k in ("PROVIDER", "MODEL", "API_KEY", "BASE_URL"):
        monkeypatch.delenv(f"RANK_{k}", raising=False)
        monkeypatch.delenv(f"EXTRACT_{k}", raising=False)
    monkeypatch.setenv("EXTRACT_API_KEY", "sk-voice")
    monkeypatch.setenv("EXTRACT_MODEL", "claude-haiku-5-5")
    cfg = rank.rank_config()
    assert (cfg.step, cfg.provider, cfg.model, cfg.api_key) == ("rank", "anthropic", "claude-opus-5-5", "sk-voice")
    monkeypatch.setenv("RANK_MODEL", "claude-sonnet-5-5")
    assert rank.rank_config().model == "claude-sonnet-5-5"
    monkeypatch.delenv("RANK_MODEL")
    monkeypatch.setenv("EXTRACT_PROVIDER", "openai_compatible")
    monkeypatch.setenv("EXTRACT_MODEL", "llama3.2")
    monkeypatch.setenv("EXTRACT_BASE_URL", "http://ollama:11434/v1")
    cfg = rank.rank_config()
    assert (cfg.provider, cfg.model, cfg.base_url) == ("openai_compatible", "llama3.2", "http://ollama:11434/v1")
    monkeypatch.setenv("RANK_PROVIDER", "gemini")
    monkeypatch.setenv("RANK_API_KEY", "g-key")
    cfg = rank.rank_config()
    assert (cfg.provider, cfg.api_key) == ("gemini", "g-key")


def test_next_run_is_the_next_three_am_in_task_tz():
    tz = ZoneInfo("America/Chicago")
    assert rank.next_run(datetime(2026, 11, 22, 2, 59, tzinfo=tz)) == datetime(2026, 11, 22, 3, 0, tzinfo=tz)
    assert rank.next_run(datetime(2026, 11, 22, 3, 0, tzinfo=tz)) == datetime(2026, 11, 23, 3, 0, tzinfo=tz)
    spring = rank.next_run(datetime(2026, 3, 7, 4, 0, tzinfo=tz))  # clocks go forward that night
    assert (spring.day, spring.hour, spring.utcoffset().total_seconds()) == (8, 3, -5 * 3600)


def test_main_stays_off_unless_scheduled(monkeypatch):
    monkeypatch.delenv("RANK_SCHEDULE", raising=False)
    monkeypatch.setattr(rank, "serve", lambda *a: pytest.fail("schedule is off"))
    assert rank.main([]) == 0
    monkeypatch.setenv("RANK_SCHEDULE", "on")
    monkeypatch.setenv("TASK_TZ", "Mars/Olympus")
    assert rank.main([]) == 0  # a bad zone stops cleanly instead of crash-looping
    monkeypatch.setenv("RANK_NUDGE", "lots")
    assert rank.main([]) == 2


def test_cost_for_known_models_only():
    assert rank.cost("claude-opus-5-5", 10_000, 2_000) == 0.08
    assert rank.cost("llama3.2", 10_000, 2_000) is None


def test_tasks_client_ranking_calls():
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path, request.url.query.decode(), request.content))
        if request.url.path == "/api/tasks/priorities":
            return httpx.Response(200, json={"text": "Focus priorities"})
        if request.method == "PUT":
            return httpx.Response(400, json={"error": "rankNudge must be -1, 0, 1 or null"})
        return httpx.Response(200, json={"today": "2026-11-22", "tasks": []})

    client = TasksClient("http://app:4321/", "tok", http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert client.focus()["tasks"] == []
    assert client.priorities() == "Focus priorities"
    with pytest.raises(TaskAPIError, match="HTTP 400"):
        client.write_ranks([{"id": "t1", "rankNudge": 2}])
    assert seen[0][:3] == ("GET", "/api/tasks", "view=focus&limit=all")
    assert seen[2][:2] == ("PUT", "/api/tasks/rank")
    assert json.loads(seen[2][3]) == {"ranks": [{"id": "t1", "rankNudge": 2}]}
    with pytest.raises(TaskAPIError):
        client.write_ranks([], [{"id": "t1", "listId": "i_g", "reason": "fits"}])
    assert json.loads(seen[3][3]) == {"ranks": [], "moves": [{"id": "t1", "listId": "i_g", "reason": "fits"}]}


def test_tasks_client_filing_log_calls():
    seen = []
    home = [
        {"id": "i_inbox", "type": "todo", "x": 60, "w": 240, "data": {}},
        {"id": "i_mine", "type": "document", "x": 400, "w": 300, "data": {"title": "Filing log", "text": "mine"}},
        {"id": "i_kid", "type": "note", "parentItemId": "i_col", "x": 5000, "w": 240, "data": {}},
    ]

    def handler(request):
        seen.append((request.method, request.url.path, json.loads(request.content) if request.content else None))
        if request.url.path == "/api/root":
            return httpx.Response(200, json={"rootCanvasId": "c_home"})
        if request.method == "GET":
            return httpx.Response(200, json={"items": home})
        return httpx.Response(200, json={"id": "i_new"})

    client = TasksClient("http://app:4321", "tok", http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert client.filing_log("Filing log") == (None, "c_home")  # the owner's own document isn't the log
    home.append({"id": "i_log", "type": "document", "data": {"title": "Filing log", "filingLog": True}})
    assert client.filing_log("Filing log")[0]["id"] == "i_log"
    client.add_card("c_home", "document", {"title": "Filing log"})
    assert seen[-1] == ("POST", "/api/item", {"canvasId": "c_home", "type": "document", "x": 740, "y": 60, "w": 320,
                                              "data": {"title": "Filing log"}})
    client.update_item("i_log", {"runs": []})
    assert seen[-1] == ("PATCH", "/api/item/i_log", {"data": {"runs": []}})
