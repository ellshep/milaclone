import io
import threading
import time

from ingest.config import Settings
from ingest.extract import Extraction, ExtractedTask
from ingest.llm import LLMError
import ingest.main as main
from ingest.main import create_app
from ingest.worker import Worker
from fastapi.testclient import TestClient

from .conftest import TASK_TOKEN


def upload(client, auth, data=b"RIFFfakeaudio", name="note.m4a", **extra):
    return client.post("/ingest/audio", headers=auth, files={"file": (name, io.BytesIO(data), "audio/x-m4a")},
                       data=extra)


def test_health_needs_no_token(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "queued": 0, "retrying": 0}
    assert client.get("/ingest/health").status_code == 200


def test_auth_required(client):
    assert client.post("/ingest/text", json={"text": "x"}).status_code == 401
    assert client.post("/ingest/text", json={"text": "x"}, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get("/ingest/recent").status_code == 401
    assert client.get("/ingest/g_x").status_code == 401
    r = upload(client, {"Authorization": "Basic abc"})
    assert r.status_code == 401
    assert r.json() == {"error": "unauthorized"}


def test_disabled_without_token(env):
    settings = Settings(ingest_token="", data_dir=env.settings.data_dir)
    env.deps.settings = settings
    with TestClient(create_app(settings=settings, deps=env.deps, start_worker=False)) as c:
        r = c.post("/ingest/text", json={"text": "x"}, headers={"Authorization": "Bearer "})
        assert r.status_code == 503
        assert "INGEST_API_TOKEN" in r.json()["error"]


def test_text_ingest_creates_tasks_synchronously(client, env):
    r = client.post("/ingest/text", headers=env.auth, json={"text": "Buy printer ink and call the dentist tomorrow"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done"
    assert [c["title"] for c in body["created"]] == ["Buy printer ink", "Call the dentist"]
    assert body["skipped"] == []
    assert body["summary"] == "Two errands."
    assert body["speech"] == "Added Buy printer ink and Call the dentist."
    assert body["extraction"]["provider"] == "fake"
    sent = env.app_api.requests
    assert sent[0] == {"title": "Buy printer ink", "notes": "", "tags": ["errands"], "dueDate": None,
                       "source": "voice-note", "dedupe": True}
    assert sent[1]["dueDate"] == "2026-11-19"
    # stored for review
    stored = client.get("/ingest/" + body["id"], headers=env.auth).json()
    assert stored["transcript"] == "Buy printer ink and call the dentist tomorrow"
    assert stored["kind"] == "text"


def test_extraction_gets_the_existing_tags(client, env):
    env.app_api.tasks = [{"id": "t_a", "text": "Old", "tags": ["taste", "Money"]},
                         {"id": "t_b", "text": "Older", "tags": ["money", " "]},
                         {"id": "t_c", "text": "Oldest"}]
    assert client.post("/ingest/text", headers=env.auth, json={"text": "Buy milk"}).status_code == 200
    assert env.deps.extractor.tags[-1] == ("Money", "taste")  # most used first, first spelling kept


def test_extraction_runs_without_tags_when_the_task_api_is_down(client, env):
    env.deps.tasks.token = ""
    r = client.post("/ingest/text", headers=env.auth, json={"text": "Buy milk"})
    assert env.deps.extractor.tags[-1] == ()
    assert r.json()["status"] == "error"  # creating the tasks then fails as before


def test_a_task_naming_a_filing_list_is_filed_there(client, env):
    env.app_api.lists = [{"id": "i_err", "title": "Errands", "boardTitle": "Home"},
                         {"id": "i_g1", "title": "Garden", "boardTitle": "House"},
                         {"id": "i_g2", "title": "garden", "boardTitle": "Allotment"}]
    env.deps.extractor.result = Extraction(summary="s", tasks=[
        ExtractedTask(title="Post the parcel", listName="Errands"), ExtractedTask(title="Call mum")])
    assert client.post("/ingest/text", headers=env.auth, json={"text": "x"}).status_code == 200
    assert env.deps.extractor.lists[-1] == ("Errands",)  # two lists called Garden: naming it can't pick one
    sent = env.app_api.requests
    assert sent[0]["listId"] == "i_err"
    assert "listId" not in sent[1]  # no list named: the Inbox


def test_extraction_runs_without_filing_lists_when_they_cannot_be_read(client, env):
    env.app_api.lists = None  # the app answers 500
    assert client.post("/ingest/text", headers=env.auth, json={"text": "Buy milk"}).status_code == 200
    assert env.deps.extractor.lists[-1] == ()


def test_text_ingest_does_not_block_other_requests(client, env):
    started, release = threading.Event(), threading.Event()
    slow = env.deps.extractor

    def blocking(transcript, tags=(), lists=()):
        started.set()
        release.wait(5)
        return slow(transcript, tags, lists)

    env.deps.extractor = blocking
    result = {}
    t = threading.Thread(target=lambda: result.update(
        r=client.post("/ingest/text", headers=env.auth, json={"text": "Buy printer ink"})))
    t.start()
    try:
        assert started.wait(5)
        begin = time.monotonic()
        assert client.get("/health").status_code == 200
        assert time.monotonic() - begin < 2  # answered while the extraction still runs
    finally:
        release.set()
        t.join(10)
    assert result["r"].status_code == 200 and result["r"].json()["status"] == "done"


def test_text_ingest_plain_body_and_source(client, env):
    r = client.post("/ingest/text", headers={**env.auth, "Content-Type": "text/plain"}, content="Buy milk")
    assert r.status_code == 200
    r = client.post("/ingest/text", headers=env.auth, json={"text": "Buy milk", "source": "alexa"})
    assert env.app_api.requests[-1]["source"] == "alexa"


def test_text_ingest_validation(client, env):
    assert client.post("/ingest/text", headers=env.auth, json={"text": "   "}).status_code == 400
    assert client.post("/ingest/text", headers=env.auth, json={"nope": 1}).status_code == 400
    assert client.post("/ingest/text", headers=env.auth, json=["x"]).status_code == 400
    assert client.post("/ingest/text", headers=env.auth, json={"text": "x", "source": 5}).status_code == 400
    assert client.post("/ingest/text", headers=env.auth, json={"text": "x", "source": "bad source!"}).status_code == 400
    assert client.post("/ingest/text", headers=env.auth, json={"text": "x" * 20001}).status_code == 413
    r = client.post("/ingest/text", headers={**env.auth, "Content-Type": "application/json"}, content="{bad")
    assert r.status_code == 400


def test_duplicates_are_skipped_and_spoken(client, env):
    client.post("/ingest/text", headers=env.auth, json={"text": "first"})
    body = client.post("/ingest/text", headers=env.auth, json={"text": "again"}).json()
    assert body["created"] == []
    assert [s["title"] for s in body["skipped"]] == ["Buy printer ink", "Call the dentist"]
    assert body["skipped"][0]["reason"] == "duplicate"
    assert body["speech"] == "Buy printer ink and Call the dentist are already on your list."


def test_extraction_failure_keeps_transcript(client, env):
    env.deps.extractor.error = LLMError("extract failed after 2 attempts: bad json")
    body = client.post("/ingest/text", headers=env.auth, json={"text": "remember the thing"}).json()
    assert body["status"] == "extraction_failed"
    assert body["transcript"] == "remember the thing"
    assert "bad json" in body["error"]
    assert body["created"] == []
    assert body["speech"] == "I saved your note, but couldn't pick out tasks from it."
    assert env.app_api.requests == []


def test_task_api_failure_is_recorded(client, env):
    env.app_api.fail_titles.add("Call the dentist")
    body = client.post("/ingest/text", headers=env.auth, json={"text": "x"}).json()
    assert body["status"] == "error"
    assert [c["title"] for c in body["created"]] == ["Buy printer ink"]
    assert "Call the dentist" in body["error"]
    assert body["speech"] == "Added Buy printer ink."


def test_task_api_failure_with_nothing_created(client, env):
    env.app_api.fail_titles.update({"Buy printer ink", "Call the dentist"})
    body = client.post("/ingest/text", headers=env.auth, json={"text": "x"}).json()
    assert body["speech"] == "Sorry, I couldn't add that."


def test_no_tasks_in_note(client, env):
    env.deps.extractor.result.tasks = []
    body = client.post("/ingest/text", headers=env.auth, json={"text": "just thinking out loud"}).json()
    assert body["status"] == "done"
    assert body["speech"] == "I didn't hear any tasks in that."


def test_audio_is_queued_then_processed(client, env):
    r = upload(client, env.auth)
    assert r.status_code == 202
    ingest_id = r.json()["id"]
    assert r.json()["status"] == "queued"
    assert client.get("/health").json()["queued"] == 1
    queued = client.get("/ingest/" + ingest_id, headers=env.auth).json()
    assert queued["status"] == "queued"
    assert queued["speech"] is None
    assert queued["filename"] == "note.m4a"
    # the stored file keeps the extension and lives under the data dir
    files = list((env.settings.data_dir / "audio").iterdir())
    assert [f.name for f in files] == [ingest_id + ".m4a"]

    assert client.worker.run_once() is True
    assert client.worker.run_once() is False
    done = client.get("/ingest/" + ingest_id, headers=env.auth).json()
    assert done["status"] == "done"
    assert done["transcript"] == "Buy printer ink. Call the dentist tomorrow."
    assert done["audioSeconds"] == 12.5
    assert done["transcribeMs"] == 340
    assert len(done["created"]) == 2
    assert env.deps.extractor.calls == ["Buy printer ink. Call the dentist tomorrow."]


def test_audio_upload_rules(client, env):
    assert upload(client, env.auth, data=b"").status_code == 400
    r = upload(client, env.auth, name="../../evil.sh;rm")
    assert r.status_code == 202
    stored = env.deps.store.get(r.json()["id"])
    assert stored["audio_filename"] == r.json()["id"] + ".m4a"
    assert stored["original_filename"] == "evil.sh;rm"
    r = upload(client, env.auth, name="memo.WAV", source="esp32")
    assert env.deps.store.get(r.json()["id"])["audio_filename"].endswith(".wav")
    assert env.deps.store.get(r.json()["id"])["source"] == "esp32"
    assert upload(client, env.auth, source="no spaces").status_code == 400
    assert client.post("/ingest/audio", headers=env.auth).status_code == 422


def test_audio_too_large(env):
    from dataclasses import replace

    env.deps.settings = replace(env.settings, max_audio_mb=1)
    with TestClient(create_app(deps=env.deps, start_worker=False)) as c:
        r = upload(c, env.auth, data=b"x" * (1024 * 1024 + 1))
        assert r.status_code == 413
        assert list((env.settings.data_dir / "audio").iterdir()) == []


def test_transcription_failure(client, env):
    env.deps.transcriber.fail = RuntimeError("could not decode")
    ingest_id = upload(client, env.auth).json()["id"]
    client.worker.run_once()
    rec = client.get("/ingest/" + ingest_id, headers=env.auth).json()
    assert rec["status"] == "error"
    assert "could not decode" in rec["error"]


def test_empty_transcript(client, env):
    env.deps.transcriber.text = ""
    ingest_id = upload(client, env.auth).json()["id"]
    client.worker.run_once()
    rec = client.get("/ingest/" + ingest_id, headers=env.auth).json()
    assert rec["status"] == "done"
    assert rec["created"] == []
    assert env.deps.extractor.calls == []


def test_worker_survives_a_crashing_job(client, env, monkeypatch):
    import ingest.worker as w

    monkeypatch.setattr(w, "process_audio", lambda deps, job: (_ for _ in ()).throw(ValueError("kaboom")))
    ingest_id = upload(client, env.auth).json()["id"]
    assert client.worker.run_once() is True
    rec = env.deps.store.get(ingest_id)
    assert rec["status"] == "error"
    assert "kaboom" in rec["error"]


def test_background_thread_processes_queue(env):
    with TestClient(create_app(deps=env.deps, start_worker=True)) as c:
        ingest_id = upload(c, env.auth).json()["id"]
        for _ in range(100):
            if env.deps.store.get(ingest_id)["status"] == "done":
                break
            time.sleep(0.05)
        assert env.deps.store.get(ingest_id)["status"] == "done"



def test_startup_preloads_the_extract_sdk(env, monkeypatch):
    seen, done = [], threading.Event()
    monkeypatch.setattr(main, "preload", lambda cfg: (seen.append(cfg), done.set()))
    with TestClient(create_app(deps=env.deps, start_worker=False)) as c:
        assert c.get("/health").status_code == 200
        assert done.wait(2)
    assert seen == [env.deps.settings.extract]

def test_restart_requeues_interrupted_audio(env):
    store = env.deps.store
    a = store.create(kind="audio", source="voice-note", status="transcribing", audio_filename="a.m4a")
    t = store.create(kind="text", source="voice-note", status="extracting", transcript="x")
    worker = Worker(env.deps)
    assert store.requeue_interrupted() == 1
    assert store.get(a)["status"] == "queued"
    assert store.get(t)["status"] == "error"
    assert worker.run_once() is True


def test_recent_and_review(client, env):
    for i in range(3):
        client.post("/ingest/text", headers=env.auth, json={"text": f"note {i}"})
    r = client.get("/ingest/recent?limit=2", headers=env.auth).json()
    assert [g["transcript"] for g in r["ingests"]] == ["note 2", "note 1"]
    assert len(client.get("/ingest/recent?limit=0", headers=env.auth).json()["ingests"]) == 1
    assert client.get("/ingest/g_missing", headers=env.auth).status_code == 404
    page = client.get("/ingest/review")
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
    assert "/ingest/recent" in page.text


def test_tasks_client_without_token(env):
    from ingest.extract import ExtractedTask
    from ingest.tasks_client import TaskAPIError, TasksClient
    import httpx
    import pytest

    with pytest.raises(TaskAPIError, match="TASK_API_TOKEN"):
        TasksClient("http://app", "").create(ExtractedTask(title="x"), "api")

    def down(request):
        raise httpx.ConnectError("refused")

    client = TasksClient("http://app", TASK_TOKEN, http=httpx.Client(transport=httpx.MockTransport(down)))
    with pytest.raises(TaskAPIError, match="unreachable"):
        client.create(ExtractedTask(title="x"), "api")
