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
    def __init__(self, tasks, priorities=None):
        self.tasks, self.prio = tasks, priorities
        self.writes, self.fail = [], None

    def focus(self, limit="all"):
        if self.fail == "focus" or (self.fail == "after" and limit != "all"):
            raise TaskAPIError("task API HTTP 500")
        return {"today": "2026-11-22", "tasks": self.tasks if limit == "all" else self.tasks[:int(limit)]}

    def priorities(self):
        if self.fail == "priorities":
            raise TaskAPIError("task API unreachable")
        return self.prio

    def write_ranks(self, ranks):
        self.writes.append(ranks)
        return {"ranked": len(ranks), "skipped": []}


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


def test_nothing_to_rank_writes_nothing():
    client = FakeClient(BOARD[:2])
    assert rank.run(FAKE, client, "one-tier") == 0
    assert client.writes == []


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
