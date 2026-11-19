import json

import httpx
import pytest

from ingest.transcribe import DeepgramTranscriber, TranscribeError

REPLY = {
    "metadata": {"request_id": "r1", "duration": 61.4, "channels": 1},
    "results": {"channels": [{"alternatives": [{"transcript": " Buy printer ink on Friday. ", "confidence": 0.98}]}]},
}


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


@pytest.fixture
def audio(tmp_path):
    p = tmp_path / "note.M4A"
    p.write_bytes(b"\x00\x00\x00 ftypM4A fake audio")
    return p


def test_sends_audio_with_the_right_options(audio):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=REPLY)

    t = DeepgramTranscriber("dg-key", http=client(handler))
    r = t.transcribe(audio)
    req = seen[0]
    assert req.method == "POST"
    assert str(req.url).startswith("https://api.deepgram.com/v1/listen?")
    assert dict(req.url.params) == {"model": "nova-3", "smart_format": "true", "punctuate": "true",
                                    "language": "en", "mip_opt_out": "true"}
    assert req.headers["authorization"] == "Token dg-key"
    assert req.headers["content-type"] == "audio/mp4"
    assert req.content == audio.read_bytes()
    assert r.text == "Buy printer ink on Friday."
    assert r.audio_seconds == 61.4
    assert r.elapsed_ms >= 0


def test_options_can_change(tmp_path):
    seen = []
    p = tmp_path / "memo.unknownext"
    p.write_bytes(b"x")

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=REPLY)

    DeepgramTranscriber("k", model="nova-2", language="", mip_opt_out=False, http=client(handler)).transcribe(p)
    params = dict(seen[0].url.params)
    assert params["model"] == "nova-2"
    assert "language" not in params and "mip_opt_out" not in params
    assert seen[0].headers["content-type"] == "application/octet-stream"
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")
    DeepgramTranscriber("k", http=client(handler)).transcribe(wav)
    assert seen[-1].headers["content-type"] == "audio/wav"


def test_keyterms_go_as_one_parameter_each(audio):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=REPLY)

    DeepgramTranscriber("k", keyterms=("Claude", "Home Assistant"), http=client(handler)).transcribe(audio)
    assert seen[0].url.params.get_list("keyterm") == ["Claude", "Home Assistant"]


def test_empty_transcript_and_missing_duration(audio):
    reply = {"results": {"channels": [{"alternatives": [{"transcript": ""}]}]}}
    r = DeepgramTranscriber("k", http=client(lambda req: httpx.Response(200, json=reply))).transcribe(audio)
    assert r.text == "" and r.audio_seconds == 0.0


def test_missing_key(audio):
    with pytest.raises(TranscribeError, match="DEEPGRAM_API_KEY"):
        DeepgramTranscriber("").transcribe(audio)


@pytest.mark.parametrize(
    "response,match",
    [
        (httpx.Response(401, json={"err_code": "INVALID_AUTH", "err_msg": "Invalid credentials."}),
         "HTTP 401: Invalid credentials"),
        (httpx.Response(402, json={"message": "Insufficient credits"}), "HTTP 402: Insufficient credits"),
        (httpx.Response(503, text="down"), "HTTP 503: down"),
        (httpx.Response(200, text="not json"), "no transcript"),
        (httpx.Response(200, json={"results": {"channels": []}}), "no transcript"),
    ],
)
def test_errors(audio, response, match):
    with pytest.raises(TranscribeError, match=match):
        DeepgramTranscriber("k", http=client(lambda req: response)).transcribe(audio)


def test_unreachable_does_not_leak_the_key(audio):
    def down(req):
        raise httpx.ConnectError("refused by host with Token k")

    with pytest.raises(TranscribeError) as e:
        DeepgramTranscriber("k", http=client(down)).transcribe(audio)
    assert str(e.value) == "Deepgram unreachable: ConnectError"


def test_opens_its_own_client_when_none_given(audio, monkeypatch):
    calls = []

    class FakeClient:
        def __init__(self, timeout):
            calls.append(timeout)

        def post(self, *a, **k):
            return httpx.Response(200, json=REPLY)

        def close(self):
            calls.append("closed")

    monkeypatch.setattr(httpx, "Client", FakeClient)
    assert DeepgramTranscriber("k").transcribe(audio).text == "Buy printer ink on Friday."
    assert calls == [120.0, "closed"]


def test_bench_script(audio, monkeypatch, capsys):
    import bench
    from ingest import transcribe

    monkeypatch.setattr(transcribe.DeepgramTranscriber, "transcribe",
                        lambda self, p: transcribe.Transcript("hello there", 3.0, 1500))
    monkeypatch.setattr("sys.argv", ["bench.py", str(audio), "--model", "nova-3"])
    bench.main()
    out = capsys.readouterr().out
    assert "transcribed in 1.5 s" in out and "hello there" in out

    def boom(self, p):
        raise transcribe.TranscribeError("DEEPGRAM_API_KEY is not set")

    monkeypatch.setattr(transcribe.DeepgramTranscriber, "transcribe", boom)
    with pytest.raises(SystemExit, match="DEEPGRAM_API_KEY"):
        bench.main()


def test_reply_shape_is_json_serialisable():
    assert json.loads(json.dumps(REPLY))["metadata"]["duration"] == 61.4


@pytest.mark.parametrize("status,retryable", [(400, False), (401, False), (402, False), (403, False),
                                              (408, True), (429, True), (500, True), (502, True),
                                              (503, True), (504, True)])
def test_which_http_errors_are_worth_retrying(audio, status, retryable):
    with pytest.raises(TranscribeError) as e:
        DeepgramTranscriber("k", http=client(lambda req: httpx.Response(status, text="x"))).transcribe(audio)
    assert e.value.retryable is retryable


def test_network_trouble_is_retryable_but_setup_problems_are_not(audio):
    def timeout(req):
        raise httpx.ReadTimeout("slow")

    with pytest.raises(TranscribeError) as e:
        DeepgramTranscriber("k", http=client(timeout)).transcribe(audio)
    assert e.value.retryable is True
    with pytest.raises(TranscribeError) as e:
        DeepgramTranscriber("").transcribe(audio)
    assert e.value.retryable is False
    with pytest.raises(TranscribeError) as e:
        DeepgramTranscriber("k", http=client(lambda req: httpx.Response(200, text="?"))).transcribe(audio)
    assert e.value.retryable is False
