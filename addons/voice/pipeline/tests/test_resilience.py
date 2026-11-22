"""Transcription retries, the retry endpoint, and the failure alert."""

import io
import json
import sqlite3

import httpx
import pytest

from ingest.alerts import Alerter
from ingest.config import Settings, _delays
from ingest.llm import LLMError
from ingest.store import Store, now_ms
from ingest.transcribe import TranscribeError

from .conftest import TASK_TOKEN


def upload(client, auth, name="note.m4a"):
    r = client.post("/ingest/audio", headers=auth, files={"file": (name, io.BytesIO(b"audio"), "audio/x-m4a")})
    assert r.status_code == 202
    return r.json()["id"]


def make_due(env, ingest_id):
    env.deps.store.update(ingest_id, next_attempt_at=now_ms() - 1)


def get(client, env, ingest_id):
    return client.get("/ingest/" + ingest_id, headers=env.auth).json()


BUSY = TranscribeError("Deepgram HTTP 503: down", retryable=True)
BAD_KEY = TranscribeError("Deepgram HTTP 401: Invalid credentials.", retryable=False)


def test_temporary_failure_is_retried_later_then_succeeds(client, env):
    env.deps.transcriber.fails = [BUSY]
    gid = upload(client, env.auth)
    before = now_ms()
    client.worker.run_once()
    rec = get(client, env, gid)
    assert rec["status"] == "retrying"
    assert rec["attempts"] == 1
    assert before + 59_000 <= rec["nextAttemptAt"] <= now_ms() + 61_000
    assert "attempt 1" in rec["error"] and "retrying in 1 min" in rec["error"]
    assert env.deps.alert.sent == []
    assert client.get("/health").json() == {"ok": True, "queued": 0, "retrying": 1}

    # not due yet: the worker leaves it alone
    assert client.worker.run_once() is False
    make_due(env, gid)
    assert client.worker.run_once() is True
    rec = get(client, env, gid)
    assert rec["status"] == "done"
    assert rec["attempts"] == 2
    assert rec["error"] is None
    assert rec["nextAttemptAt"] is None
    assert len(rec["created"]) == 2
    assert env.deps.alert.sent == []


def test_gives_up_after_the_last_retry_and_alerts_once(client, env):
    env.deps.transcriber.fails = [BUSY, BUSY, BUSY, BUSY]
    gid = upload(client, env.auth)
    waits = []
    for _ in range(4):
        client.worker.run_once()
        rec = get(client, env, gid)
        if rec["status"] == "retrying":
            waits.append(round((rec["nextAttemptAt"] - now_ms()) / 1000))
            make_due(env, gid)
    assert waits == [60, 300, 900]
    assert rec["status"] == "error"
    assert rec["attempts"] == 4
    assert rec["error"].startswith("transcription failed after 4 attempts: Deepgram HTTP 503")
    assert [r["id"] for r in env.deps.alert.sent] == [gid]
    assert client.worker.run_once() is False


def test_permanent_failure_alerts_at_once(client, env):
    env.deps.transcriber.fails = [BAD_KEY]
    gid = upload(client, env.auth)
    client.worker.run_once()
    rec = get(client, env, gid)
    assert rec["status"] == "error"
    assert rec["attempts"] == 1
    assert rec["error"] == "transcription failed: Deepgram HTTP 401: Invalid credentials."
    assert len(env.deps.alert.sent) == 1


def test_unexpected_errors_are_not_retried(client, env):
    env.deps.transcriber.fails = [RuntimeError("disk full")]
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "error"
    assert len(env.deps.alert.sent) == 1


def test_retries_off(client, env):
    from dataclasses import replace

    env.deps.settings = replace(env.settings, retry_delays=())
    env.deps.transcriber.fails = [BUSY]
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "error"


def test_extraction_and_task_failures_alert(client, env):
    env.deps.extractor.error = LLMError("extract failed after 2 attempts: bad json")
    client.post("/ingest/text", headers=env.auth, json={"text": "x"})
    assert env.deps.alert.sent[-1]["status"] == "extraction_failed"
    env.deps.extractor.error = None
    env.app_api.fail_titles.add("Call the dentist")
    client.post("/ingest/text", headers=env.auth, json={"text": "y"})
    assert env.deps.alert.sent[-1]["status"] == "error"
    assert len(env.deps.alert.sent) == 2
    # a clean run sends nothing
    env.app_api.fail_titles.clear()
    client.post("/ingest/text", headers=env.auth, json={"text": "z"})
    assert len(env.deps.alert.sent) == 2


def test_a_failing_alert_never_breaks_processing(client, env):
    def boom(record):
        raise RuntimeError("webhook exploded")

    env.deps.alert = boom
    env.deps.transcriber.fails = [BAD_KEY]
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "error"


def test_worker_crash_alerts(client, env, monkeypatch):
    import ingest.worker as w

    monkeypatch.setattr(w, "process_audio", lambda deps, job: (_ for _ in ()).throw(ValueError("kaboom")))
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert env.deps.alert.sent[-1]["id"] == gid
    env.deps.alert = lambda r: (_ for _ in ()).throw(RuntimeError("no"))
    upload(client, env.auth)
    assert client.worker.run_once() is True


# ---- retry endpoint ----------------------------------------------------------


def test_retry_needs_auth_and_a_known_failed_note(client, env):
    assert client.post("/ingest/g_x/retry").status_code == 401
    assert client.post("/ingest/g_missing/retry", headers=env.auth).status_code == 404
    done = client.post("/ingest/text", headers=env.auth, json={"text": "x"}).json()
    r = client.post(f"/ingest/{done['id']}/retry", headers=env.auth)
    assert r.status_code == 409 and "already finished" in r.json()["error"]
    queued = upload(client, env.auth)
    r = client.post(f"/ingest/{queued}/retry", headers=env.auth)
    assert r.status_code == 409 and "already being processed" in r.json()["error"]


def test_retry_failed_transcription_requeues_the_saved_audio(client, env):
    env.deps.transcriber.fails = [BAD_KEY]
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "error"
    r = client.post(f"/ingest/{gid}/retry", headers=env.auth)
    assert r.status_code == 202
    assert r.json()["status"] == "queued" and r.json()["attempts"] == 0 and r.json()["error"] is None
    client.worker.run_once()
    rec = get(client, env, gid)
    assert rec["status"] == "done" and rec["attempts"] == 1
    assert len(env.deps.transcriber.calls) == 2


def test_retry_now_skips_the_wait(client, env):
    env.deps.transcriber.fails = [BUSY]
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert client.worker.run_once() is False
    assert client.post(f"/ingest/{gid}/retry", headers=env.auth).status_code == 202
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "done"


def test_retry_after_extraction_failure_reuses_the_transcript(client, env):
    gid = upload(client, env.auth)
    env.deps.extractor.error = LLMError("provider down")
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "extraction_failed"
    env.deps.extractor.error = None
    r = client.post(f"/ingest/{gid}/retry", headers=env.auth)
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "done" and len(body["created"]) == 2
    assert body["speech"] == "Added Buy printer ink and Call the dentist."
    assert len(env.deps.transcriber.calls) == 1  # not transcribed again


def test_retry_after_partial_task_failure_skips_what_was_added(client, env):
    env.app_api.fail_titles.add("Call the dentist")
    rec = client.post("/ingest/text", headers=env.auth, json={"text": "x"}).json()
    assert rec["status"] == "error"
    env.app_api.fail_titles.clear()
    body = client.post(f"/ingest/{rec['id']}/retry", headers=env.auth).json()
    assert body["status"] == "done"
    assert [c["title"] for c in body["created"]] == ["Call the dentist"]
    assert [s["title"] for s in body["skipped"]] == ["Buy printer ink"]
    assert sum(1 for t in env.app_api.tasks if t["text"] == "Buy printer ink") == 1


def test_retry_with_missing_audio(client, env):
    env.deps.transcriber.fails = [BAD_KEY]
    gid = upload(client, env.auth)
    client.worker.run_once()
    for f in (env.settings.data_dir / "audio").iterdir():
        f.unlink()
    r = client.post(f"/ingest/{gid}/retry", headers=env.auth)
    assert r.status_code == 409 and "missing" in r.json()["error"]


def test_retry_with_nothing_saved(env, client):
    gid = env.deps.store.create(kind="text", source="api", status="error")
    r = client.post(f"/ingest/{gid}/retry", headers=env.auth)
    assert r.status_code == 409 and "nothing saved" in r.json()["error"]


def test_review_page_has_retry(client):
    page = client.get("/ingest/review").text
    assert "/retry" in page and "Retry now" in page


# ---- alerter -----------------------------------------------------------------


def test_alerter_posts_reason_and_link_not_transcript(capsys):
    seen = []

    def handler(req):
        seen.append(json.loads(req.content))
        return httpx.Response(200)

    a = Alerter("http://ha.local/api/webhook/x", "https://mila.example/ingest/review",
                http=httpx.Client(transport=httpx.MockTransport(handler)))
    a({"id": "g_1", "kind": "audio", "source": "voice-note", "status": "error",
       "error": "transcription failed: Deepgram HTTP 402: no credits", "transcript": "secret words"})
    assert seen == [{
        "event": "ingest.failed", "id": "g_1", "kind": "audio", "source": "voice-note", "status": "error",
        "error": "transcription failed: Deepgram HTTP 402: no credits",
        "message": "Voice note wasn't added: transcription failed: Deepgram HTTP 402: no credits",
        "review_url": "https://mila.example/ingest/review",
    }]
    assert "secret words" not in json.dumps(seen)
    a({"id": "g_2", "kind": "text", "status": "extraction_failed", "error": None})
    assert seen[1]["message"] == "Captured text wasn't added: extraction_failed"
    assert '"alert.sent"' in capsys.readouterr().out


def test_alerter_off_and_failures(capsys, monkeypatch):
    Alerter("")({"id": "g_1"})  # no URL: nothing happens
    assert capsys.readouterr().out == ""
    bad = Alerter("http://x", http=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))
    bad({"id": "g_1", "error": "e"})
    assert '"status": 500' in capsys.readouterr().out

    def down(r):
        raise httpx.ConnectError("refused")

    Alerter("http://x", http=httpx.Client(transport=httpx.MockTransport(down)))({"id": "g_1"})
    assert "ConnectError" in capsys.readouterr().out

    calls = []

    class FakeClient:
        def __init__(self, timeout):
            calls.append(timeout)

        def post(self, url, json):
            return httpx.Response(204)

        def close(self):
            calls.append("closed")

    monkeypatch.setattr(httpx, "Client", FakeClient)
    Alerter("http://x")({"id": "g_1"})
    assert calls == [10.0, "closed"]


# ---- settings and store ------------------------------------------------------


def test_retry_delay_setting(monkeypatch):
    assert _delays("60,300,900") == (60, 300, 900)
    assert _delays(" 30 , ,120") == (30, 120)
    assert _delays("") == () and _delays("0") == ()
    with pytest.raises(ValueError):
        _delays("-5")
    monkeypatch.setenv("TRANSCRIBE_RETRY_DELAYS", "10,20")
    monkeypatch.setenv("ALERT_WEBHOOK_URL", "http://ha/x")
    monkeypatch.setenv("INGEST_REVIEW_URL", "https://m/ingest/review")
    s = Settings.from_env()
    assert s.retry_delays == (10, 20)
    assert s.alert_webhook_url == "http://ha/x" and s.review_url == "https://m/ingest/review"


def test_store_adds_new_columns_to_an_old_database(tmp_path):
    path = tmp_path / "old.db"
    db = sqlite3.connect(path)
    db.execute("""CREATE TABLE ingests (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, audio_filename TEXT,
        original_filename TEXT, status TEXT NOT NULL, transcript TEXT, extraction_json TEXT,
        created_json TEXT, skipped_json TEXT, error TEXT, transcribe_ms INTEGER, audio_seconds REAL,
        extract_ms INTEGER)""")
    db.execute("INSERT INTO ingests (id, created_at, updated_at, kind, source, status) "
               "VALUES ('g_old', 1, 1, 'audio', 'voice-note', 'queued')")
    db.commit()
    db.close()
    store = Store(path)
    rec = store.get("g_old")
    assert rec["attempts"] == 0 and rec["next_attempt_at"] is None and rec["audio_deleted_at"] is None
    assert store.next_queued()["id"] == "g_old"
    Store(path)  # opening again is a no-op


def test_tasks_token_still_used():
    assert TASK_TOKEN
