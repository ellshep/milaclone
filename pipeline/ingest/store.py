"""SQLite record of every ingest: the raw transcript, the extraction result and
what was created. Rows are never deleted, so nothing captured is silently lost.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS ingests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- audio | text
  source TEXT NOT NULL,
  audio_filename TEXT,
  original_filename TEXT,
  status TEXT NOT NULL,            -- queued | transcribing | retrying | extracting | done | extraction_failed | error
  transcript TEXT,
  extraction_json TEXT,
  created_json TEXT,
  skipped_json TEXT,
  error TEXT,
  transcribe_ms INTEGER,
  audio_seconds REAL,
  extract_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,  -- transcription attempts made
  next_attempt_at INTEGER               -- when a 'retrying' job is due (ms)
);
CREATE INDEX IF NOT EXISTS idx_ingests_status ON ingests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_ingests_created ON ingests(created_at);
"""

JSON_FIELDS = ("extraction_json", "created_json", "skipped_json")
FIELDS = (
    "status",
    "transcript",
    "extraction_json",
    "created_json",
    "skipped_json",
    "error",
    "transcribe_ms",
    "audio_seconds",
    "extract_ms",
    "audio_filename",
    "attempts",
    "next_attempt_at",
)

# Columns added after the first release, for databases created before them.
ADDED_COLUMNS = {
    "attempts": "INTEGER NOT NULL DEFAULT 0",
    "next_attempt_at": "INTEGER",
}


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id() -> str:
    return "g_" + secrets.token_urlsafe(9)


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA synchronous = NORMAL")
        self._db.executescript(SCHEMA)
        cols = {r["name"] for r in self._db.execute("PRAGMA table_info(ingests)")}
        for name, decl in ADDED_COLUMNS.items():
            if name not in cols:
                self._db.execute(f"ALTER TABLE ingests ADD COLUMN {name} {decl}")

    def close(self) -> None:
        with self._lock:
            self._db.close()

    def create(self, *, kind: str, source: str, status: str, transcript: str | None = None,
               audio_filename: str | None = None, original_filename: str | None = None,
               ingest_id: str | None = None) -> str:
        ingest_id = ingest_id or new_id()
        now = int(time.time() * 1000)
        with self._lock:
            self._db.execute(
                "INSERT INTO ingests (id, created_at, updated_at, kind, source, audio_filename, "
                "original_filename, status, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (ingest_id, now, now, kind, source, audio_filename, original_filename, status, transcript),
            )
        return ingest_id

    def update(self, ingest_id: str, **fields) -> None:
        bad = set(fields) - set(FIELDS)
        if bad:
            raise ValueError(f"unknown fields: {sorted(bad)}")
        cols, vals = [], []
        for k, v in fields.items():
            if k in JSON_FIELDS and v is not None:
                v = json.dumps(v)
            cols.append(f"{k} = ?")
            vals.append(v)
        cols.append("updated_at = ?")
        vals.append(int(time.time() * 1000))
        with self._lock:
            self._db.execute(f"UPDATE ingests SET {', '.join(cols)} WHERE id = ?", (*vals, ingest_id))

    def get(self, ingest_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM ingests WHERE id = ?", (ingest_id,)).fetchone()
        return _row(row) if row else None

    def recent(self, limit: int = 20) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM ingests ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_row(r) for r in rows]

    def next_queued(self, now: int | None = None) -> dict | None:
        """The next job to run: a queued one, or a retry whose wait is over."""
        now = now_ms() if now is None else now
        with self._lock:
            row = self._db.execute(
                "SELECT * FROM ingests WHERE status = 'queued' "
                "OR (status = 'retrying' AND COALESCE(next_attempt_at, 0) <= ?) "
                "ORDER BY COALESCE(next_attempt_at, created_at), created_at, id LIMIT 1",
                (now,),
            ).fetchone()
        return _row(row) if row else None

    def count(self, *statuses: str) -> int:
        marks = ",".join("?" * len(statuses))
        with self._lock:
            return self._db.execute(f"SELECT COUNT(*) FROM ingests WHERE status IN ({marks})", statuses).fetchone()[0]

    def requeue_interrupted(self) -> int:
        """Audio jobs cut off by a restart go back in the queue. A text ingest
        caught mid-extraction is marked as an error instead: its caller already
        got an answer, and it still has its transcript."""
        now = int(time.time() * 1000)
        with self._lock:
            n = self._db.execute(
                "UPDATE ingests SET status = 'queued', updated_at = ? "
                "WHERE kind = 'audio' AND status IN ('transcribing', 'extracting')",
                (now,),
            ).rowcount
            self._db.execute(
                "UPDATE ingests SET status = 'error', error = 'interrupted by a restart', updated_at = ? "
                "WHERE kind = 'text' AND status = 'extracting'",
                (now,),
            )
        return n


def _row(row: sqlite3.Row) -> dict:
    d = dict(row)
    for k in JSON_FIELDS:
        d[k.removesuffix("_json")] = json.loads(d.pop(k)) if d.get(k) else None
    return d
