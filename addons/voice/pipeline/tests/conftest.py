import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from ingest.config import Settings, StepConfig
from ingest.extract import Extraction, ExtractedTask
from ingest.llm import LLMError, LLMResult
from ingest.main import create_app
from ingest.process import Deps
from ingest.store import Store
from ingest.tasks_client import TasksClient
from ingest.transcribe import Transcript

TOKEN = "ingest-token-0123456789"
TASK_TOKEN = "task-token-0123456789"


class FakeTranscriber:
    def __init__(self, text="Buy printer ink. Call the dentist tomorrow."):
        self.text = text
        self.calls = []
        self.fail = None
        self.fails = []  # errors raised by the next calls, one per call

    def transcribe(self, path: Path) -> Transcript:
        self.calls.append(path)
        if self.fails:
            raise self.fails.pop(0)
        if self.fail:
            raise self.fail
        return Transcript(self.text, 12.5, 340)


class FakeApp:
    """Stands in for milaclone's /api/tasks with the same dedupe rule."""

    def __init__(self):
        self.tasks = []
        self.requests = []
        self.fail_titles = set()
        self.lists = []  # what GET /api/tasks/lists?label=Filing answers
        self.gone_lists = set()  # list ids a POST is refused for (trashed since they were read)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {TASK_TOKEN}":
            return httpx.Response(401, json={"error": "unauthorized"})
        if request.url.path == "/api/tasks/lists":
            assert request.url.params["label"] == "Filing"
            if self.lists is None:
                return httpx.Response(500, text="boom")
            return httpx.Response(200, json={"lists": self.lists})
        assert request.url.path == "/api/tasks"
        if request.method == "GET":
            return httpx.Response(200, json={"tasks": self.tasks})
        body = json.loads(request.content)
        self.requests.append(body)
        if body["title"] in self.fail_titles:
            return httpx.Response(500, text="boom")
        if body.get("listId") in self.gone_lists:
            return httpx.Response(400, json={"error": "listId is not a to-do list"})
        key = " ".join(body["title"].lower().split())
        for t in self.tasks:
            if body.get("dedupe") and " ".join(t["text"].lower().split()) == key:
                return httpx.Response(200, json={"task": t, "created": False, "duplicate": True})
        t = {"id": f"t_{len(self.tasks)}", "text": body["title"], "listTitle": "Inbox", **body}
        self.tasks.append(t)
        return httpx.Response(201, json={"task": t, "created": True})


class FakeExtractor:
    def __init__(self):
        self.result = Extraction(summary="Two errands.", tasks=[
            ExtractedTask(title="Buy printer ink", tags=["errands"]),
            ExtractedTask(title="Call the dentist", dueDate="2026-11-19"),
        ])
        self.error = None
        self.calls = []
        self.tags = []
        self.lists = []

    def __call__(self, transcript: str, tags: tuple[str, ...] = (), lists: tuple[str, ...] = ()) -> LLMResult:
        self.calls.append(transcript)
        self.tags.append(tags)
        self.lists.append(lists)
        if self.error:
            raise self.error
        return LLMResult(self.result, "fake", "fake", 10, 20, 5, 1)


class FakeAlert:
    def __init__(self):
        self.sent = []

    def __call__(self, record):
        self.sent.append(record)


@pytest.fixture
def env(tmp_path):
    settings = Settings(ingest_token=TOKEN, task_token=TASK_TOKEN, app_url="http://app:4321",
                        data_dir=tmp_path, extract=StepConfig("extract", "fake", "fake"))
    fake_app = FakeApp()
    http = httpx.Client(transport=httpx.MockTransport(fake_app.handler))
    deps = Deps(
        settings=settings,
        store=Store(tmp_path / "ingest.db"),
        transcriber=FakeTranscriber(),
        tasks=TasksClient(settings.app_url, TASK_TOKEN, http=http),
        extractor=FakeExtractor(),
        alert=FakeAlert(),
    )

    class Env:
        pass

    e = Env()
    e.settings, e.deps, e.app_api = settings, deps, fake_app
    e.auth = {"Authorization": f"Bearer {TOKEN}"}
    return e


@pytest.fixture
def client(env):
    app = create_app(deps=env.deps, start_worker=False)
    with TestClient(app) as c:
        c.worker = app.state.worker
        yield c
