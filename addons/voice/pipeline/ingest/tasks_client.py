"""milaclone's task API (docs/task-api.md): creates tasks for the ingest
pipeline, reads the focus order and writes the nightly ranking."""

from __future__ import annotations

from collections import Counter

import httpx

from .extract import ExtractedTask


class TaskAPIError(Exception):
    pass


TAGS_MAX = 100  # the most used ones, so the prompt and schema stay small


class TasksClient:
    def __init__(self, app_url: str, token: str, http: httpx.Client | None = None):
        self.app_url = app_url.rstrip("/")
        self.token = token
        self.http = http or httpx.Client(timeout=15.0)

    def _call(self, method: str, path: str, **kw) -> dict:
        if not self.token:
            raise TaskAPIError("TASK_API_TOKEN is not set for the pipeline")
        try:
            r = self.http.request(method, self.app_url + path,
                                  headers={"Authorization": f"Bearer {self.token}"}, **kw)
        except httpx.HTTPError as e:
            raise TaskAPIError(f"task API unreachable: {e}") from e
        if r.status_code not in (200, 201):
            raise TaskAPIError(f"task API HTTP {r.status_code}: {r.text[:200]}")
        return r.json()

    def existing_tags(self) -> tuple[str, ...]:
        """Every tag on the task list (open and done), most used first."""
        counts, spelling = Counter(), {}
        for task in self._call("GET", "/api/tasks", params={"status": "all"}).get("tasks", []):
            for tag in task.get("tags") or []:
                if isinstance(tag, str) and tag.strip():
                    key = tag.strip().lower()
                    counts[key] += 1
                    spelling.setdefault(key, tag.strip())
        ranked = sorted(counts, key=lambda k: (-counts[k], k))[:TAGS_MAX]
        return tuple(spelling[k] for k in ranked)

    def create(self, task: ExtractedTask, source: str) -> dict:
        """Returns {"task": {...}, "created": bool, "duplicate": bool}. The app
        skips a task whose title matches an open task (dedupe) and says so."""
        body = {
            "title": task.title,
            "notes": task.notes,
            "tags": task.tags,
            "dueDate": task.dueDate,
            "source": source,
            "dedupe": True,
        }
        data = self._call("POST", "/api/tasks", json=body)
        return {"task": data["task"], "created": bool(data.get("created")),
                "duplicate": bool(data.get("duplicate"))}

    def focus(self, limit: str = "all") -> dict:
        """The focus order: {today, tasks, counts}, each task with its tier."""
        return self._call("GET", "/api/tasks", params={"view": "focus", "limit": limit})

    def priorities(self) -> str | None:
        """The Home note headed "Focus priorities", or None."""
        return self._call("GET", "/api/tasks/priorities").get("text")

    def write_ranks(self, ranks: list[dict]) -> dict:
        """One transaction on the app's side: all of it lands or none does."""
        return self._call("PUT", "/api/tasks/rank", json={"ranks": ranks})
