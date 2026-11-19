"""HTTP surface of the ingest pipeline.

Run: uvicorn ingest.main:create_app --factory --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import hmac
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from .config import Settings
from .logs import log
from .process import Deps, default_extractor, extract_and_create, speech_for
from .store import Store, new_id
from .tasks_client import TasksClient
from .transcribe import DeepgramTranscriber
from .worker import Worker

STATIC = Path(__file__).parent / "static"
TEXT_MAX = 20000
SOURCE_RE = re.compile(r"^[A-Za-z0-9._-]{1,40}$")
EXT_RE = re.compile(r"^\.[a-z0-9]{1,8}$")
CHUNK = 1024 * 1024


def _public(record: dict) -> dict:
    return {
        "id": record["id"],
        "createdAt": record["created_at"],
        "kind": record["kind"],
        "source": record["source"],
        "status": record["status"],
        "filename": record.get("original_filename"),
        "transcript": record.get("transcript"),
        "summary": (record.get("extraction") or {}).get("summary"),
        "extraction": record.get("extraction"),
        "created": record.get("created") or [],
        "skipped": record.get("skipped") or [],
        "error": record.get("error"),
        "audioSeconds": record.get("audio_seconds"),
        "transcribeMs": record.get("transcribe_ms"),
        "extractMs": record.get("extract_ms"),
    }


def create_app(settings: Settings | None = None, deps: Deps | None = None, start_worker: bool = True) -> FastAPI:
    settings = settings or (deps.settings if deps else Settings.from_env())
    if deps is None:
        deps = Deps(
            settings=settings,
            store=Store(settings.data_dir / "ingest.db"),
            transcriber=DeepgramTranscriber(settings.deepgram_api_key, settings.deepgram_model,
                                            settings.deepgram_language, settings.deepgram_mip_opt_out),
            tasks=TasksClient(settings.app_url, settings.task_token),
            extractor=default_extractor(settings),
        )
    deps.audio_dir.mkdir(parents=True, exist_ok=True)
    worker = Worker(deps)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if start_worker:
            worker.start()
        log("pipeline.start", transcribe_model=settings.deepgram_model, deepgram_key=bool(settings.deepgram_api_key), extract_provider=settings.extract.provider,
            extract_model=settings.extract.model or None, auth=bool(settings.ingest_token))
        yield
        if start_worker:
            worker.stop()

    app = FastAPI(title="milaclone ingest", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.deps = deps
    app.state.worker = worker

    def auth(request: Request) -> None:
        expected = settings.ingest_token
        if not expected:
            raise HTTPException(503, "ingest API disabled: INGEST_API_TOKEN is not set")
        m = re.match(r"^Bearer\s+(.+)$", request.headers.get("authorization", ""), re.I)
        given = m.group(1).strip() if m else ""
        if not hmac.compare_digest(given.encode(), expected.encode()):
            raise HTTPException(401, "unauthorized")

    def clean_source(v: str | None, default: str) -> str:
        if v is None or v == "":
            return default
        if not SOURCE_RE.match(v):
            raise HTTPException(400, "source must be 1-40 letters, digits, '.', '_' or '-'")
        return v

    @app.get("/health")
    @app.get("/ingest/health")
    def health():
        return {"ok": True, "queued": deps.store.count("queued")}

    @app.post("/ingest/audio", status_code=202, dependencies=[Depends(auth)])
    async def ingest_audio(file: UploadFile = File(...), source: str | None = Form(None)):
        src = clean_source(source, "voice-note")
        original = Path(file.filename or "audio").name[:200]
        ext = Path(original).suffix.lower()
        if not EXT_RE.match(ext):
            ext = ".m4a"
        ingest_id = new_id()
        stored = ingest_id + ext
        dest = deps.audio_dir / stored
        limit = settings.max_audio_mb * CHUNK
        size = 0
        with dest.open("wb") as out:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > limit:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise HTTPException(413, f"audio is larger than {settings.max_audio_mb} MB")
                out.write(chunk)
        if size == 0:
            dest.unlink(missing_ok=True)
            raise HTTPException(400, "empty audio file")
        deps.store.create(kind="audio", source=src, status="queued", audio_filename=stored,
                          original_filename=original, ingest_id=ingest_id)
        log("ingest.queued", id=ingest_id, kind="audio", source=src, bytes=size)
        worker.notify()
        return {"id": ingest_id, "status": "queued"}

    @app.post("/ingest/text", dependencies=[Depends(auth)])
    async def ingest_text(request: Request):
        ctype = request.headers.get("content-type", "")
        source = None
        if ctype.startswith("application/json"):
            try:
                body = await request.json()
            except ValueError:
                raise HTTPException(400, "body is not valid JSON")
            if not isinstance(body, dict) or not isinstance(body.get("text"), str):
                raise HTTPException(400, "send {\"text\": \"...\"}")
            text, source = body["text"], body.get("source")
            if source is not None and not isinstance(source, str):
                raise HTTPException(400, "source must be a string")
        else:
            text = (await request.body()).decode("utf-8", errors="replace")
        text = text.strip()
        if not text:
            raise HTTPException(400, "text is empty")
        if len(text) > TEXT_MAX:
            raise HTTPException(413, f"text is longer than {TEXT_MAX} characters")
        src = clean_source(source, "voice-note")
        ingest_id = deps.store.create(kind="text", source=src, status="extracting", transcript=text)
        log("ingest.received", id=ingest_id, kind="text", source=src, chars=len(text))
        record = extract_and_create(deps, ingest_id, text, src)
        return {**_public(record), "speech": speech_for(record)}

    @app.get("/ingest/recent", dependencies=[Depends(auth)])
    def recent(limit: int = 20):
        limit = max(1, min(limit, 200))
        return {"ingests": [_public(r) for r in deps.store.recent(limit)]}

    @app.get("/ingest/review")
    def review():
        # The page holds no data; it asks for the token and calls /ingest/recent.
        return FileResponse(STATIC / "review.html", media_type="text/html")

    @app.get("/ingest/{ingest_id}", dependencies=[Depends(auth)])
    def get_one(ingest_id: str):
        record = deps.store.get(ingest_id)
        if not record:
            raise HTTPException(404, "not found")
        return {**_public(record), "speech": speech_for(record) if record["status"] not in
                ("queued", "transcribing", "extracting") else None}

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code)

    return app
