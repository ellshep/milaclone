"""Creates tasks through milaclone's task API (POST /api/tasks)."""

from __future__ import annotations

import httpx

from .extract import ExtractedTask


class TaskAPIError(Exception):
    pass


class TasksClient:
    def __init__(self, app_url: str, token: str, http: httpx.Client | None = None):
        self.app_url = app_url.rstrip("/")
        self.token = token
        self.http = http or httpx.Client(timeout=15.0)

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
