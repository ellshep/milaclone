"""Creates tasks through milaclone's task API (POST /api/tasks)."""

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

    def existing_tags(self) -> tuple[str, ...]:
        """Every tag on the task list (open and done), most used first."""
        if not self.token:
            raise TaskAPIError("TASK_API_TOKEN is not set for the pipeline")
        try:
            r = self.http.get(self.app_url + "/api/tasks", params={"status": "all"},
                              headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise TaskAPIError(f"task API unreachable: {e}") from e
        if r.status_code != 200:
            raise TaskAPIError(f"task API HTTP {r.status_code}: {r.text[:200]}")
        counts, spelling = Counter(), {}
        for task in r.json().get("tasks", []):
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
        if not self.token:
            raise TaskAPIError("TASK_API_TOKEN is not set for the pipeline")
        body = {
            "title": task.title,
            "notes": task.notes,
            "tags": task.tags,
            "dueDate": task.dueDate,
            "source": source,
            "dedupe": True,
        }
        try:
            r = self.http.post(self.app_url + "/api/tasks", json=body,
                               headers={"Authorization": f"Bearer {self.token}"})
        except httpx.HTTPError as e:
            raise TaskAPIError(f"task API unreachable: {e}") from e
        if r.status_code not in (200, 201):
            raise TaskAPIError(f"task API HTTP {r.status_code}: {r.text[:200]}")
        data = r.json()
        return {"task": data["task"], "created": bool(data.get("created")),
                "duplicate": bool(data.get("duplicate"))}
