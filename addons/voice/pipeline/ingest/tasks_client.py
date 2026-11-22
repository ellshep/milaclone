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

    def filing_lists(self) -> dict[str, str]:
        """The lists labelled Filing, title -> id. A title two lists share is
        left out: naming it can't pick one, so those tasks go to the Inbox."""
        lists = self._call("GET", "/api/tasks/lists", params={"label": "Filing"}).get("lists", [])
        titles = [str(lst.get("title") or "").strip() for lst in lists]
        counts = Counter(t.lower() for t in titles)
        return {t: lst["id"] for t, lst in zip(titles, lists) if t and counts[t.lower()] == 1}

    def create(self, task: ExtractedTask, source: str, list_id: str | None = None) -> dict:
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
        if list_id:
            body["listId"] = list_id
        data = self._call("POST", "/api/tasks", json=body)
        return {"task": data["task"], "created": bool(data.get("created")),
                "duplicate": bool(data.get("duplicate"))}

    def focus(self, limit: str = "all") -> dict:
        """The focus order: {today, tasks, counts}, each task with its tier."""
        return self._call("GET", "/api/tasks", params={"view": "focus", "limit": limit})

    def priorities(self) -> str | None:
        """The Home note headed "Focus priorities", or None."""
        return self._call("GET", "/api/tasks/priorities").get("text")

    def filing_log(self, title: str) -> tuple[dict | None, str]:
        """The document card on Home titled `title` and marked `filingLog` (the
        ranker's filing log), or None; and Home's id. Board routes, not the task API."""
        home = self._call("GET", "/api/root")["rootCanvasId"]
        items = self._call("GET", f"/api/canvas/{home}").get("items", [])
        card = next((it for it in items if it.get("type") == "document" and not it.get("parentItemId")
                     and (it.get("data") or {}).get("title") == title and it["data"].get("filingLog")), None)
        return card, home

    def update_item(self, item_id: str, data: dict) -> dict:
        return self._call("PATCH", f"/api/item/{item_id}", json={"data": data})

    def add_card(self, canvas_id: str, kind: str, data: dict) -> dict:
        """A new card on a board, to the right of its cards so it covers none."""
        items = self._call("GET", f"/api/canvas/{canvas_id}").get("items", [])
        right = max([(it.get("x") or 0) + (it.get("w") or 240) for it in items if not it.get("parentItemId")] or [20])
        return self._call("POST", "/api/item", json={"canvasId": canvas_id, "type": kind, "x": right + 40, "y": 60,
                                                      "w": 320, "data": data})

    def write_ranks(self, ranks: list[dict], moves: list[dict] | None = None) -> dict:
        """One transaction on the app's side: all of it lands or none does,
        the Inbox tasks filed by `moves` (M3.3) included."""
        body = {"ranks": ranks, **({"moves": moves} if moves else {})}
        return self._call("PUT", "/api/tasks/rank", json=body)
