"""Recording retention (N15): audio deleted 7 days after an ingest is done."""

from ingest.process import delete_old_audio
from ingest.store import now_ms
from ingest.transcribe import TranscribeError

from .test_resilience import get, upload

LATER = 8 * 86_400_000


def audio_path(env, gid):
    return env.deps.audio_dir / env.deps.store.get(gid)["audio_filename"]


def test_done_audio_goes_after_seven_days_and_the_record_stays(client, env):
    gid = upload(client, env.auth)
    client.worker.run_once()
    path = audio_path(env, gid)
    assert path.is_file()
    assert delete_old_audio(env.deps, now_ms() + 6 * 86_400_000) == 0  # too soon
    assert path.is_file()

    now = now_ms() + LATER
    assert delete_old_audio(env.deps, now) == 1
    assert not path.exists()
    rec = get(client, env, gid)
    assert rec["status"] == "done" and rec["audioDeletedAt"] == now
    assert rec["transcript"] and rec["created"]
    assert delete_old_audio(env.deps, now + LATER) == 0  # once only

    r = client.post(f"/ingest/{gid}/retry", headers=env.auth)
    assert r.status_code == 409 and "already finished" in r.json()["error"]


def test_failed_ingests_keep_their_audio(client, env):
    env.deps.transcriber.fails = [TranscribeError("Deepgram HTTP 401: bad key", retryable=False)]
    gid = upload(client, env.auth)
    client.worker.run_once()
    assert get(client, env, gid)["status"] == "error"
    assert delete_old_audio(env.deps, now_ms() + LATER) == 0
    assert audio_path(env, gid).is_file()


def test_a_file_already_gone_is_still_marked(client, env):
    gid = upload(client, env.auth)
    client.worker.run_once()
    audio_path(env, gid).unlink()
    assert delete_old_audio(env.deps, now_ms() + LATER) == 1
    assert get(client, env, gid)["audioDeletedAt"]


def test_worker_sweep_survives_errors(client, env, monkeypatch):
    import ingest.worker as w

    def boom(deps):
        raise RuntimeError("disk")
    monkeypatch.setattr(w, "delete_old_audio", boom)
    client.worker.sweep()  # logs, doesn't raise
