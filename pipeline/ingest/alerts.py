"""One push per ingest that finally failed, to a webhook such as Home Assistant's.

Sent when a note is given up on (transcription failed for good or ran out of
retries, extraction failed, or the task list refused tasks), never for a
failure that will be retried. Carries the reason and a link, not the
transcript. A failed alert is logged and otherwise ignored.
"""

from __future__ import annotations

import httpx

from .logs import log

TIMEOUT_S = 10.0
ERROR_MAX = 200


class Alerter:
    def __init__(self, url: str, review_url: str = "", http: httpx.Client | None = None):
        self.url = url
        self.review_url = review_url
        self.http = http

    def __call__(self, record: dict) -> None:
        if not self.url:
            return
        reason = (record.get("error") or record.get("status") or "unknown error")[:ERROR_MAX]
        what = "Voice note" if record.get("kind") == "audio" else "Captured text"
        payload = {
            "event": "ingest.failed",
            "id": record["id"],
            "kind": record.get("kind"),
            "source": record.get("source"),
            "status": record.get("status"),
            "error": reason,
            "message": f"{what} wasn't added: {reason}",
            "review_url": self.review_url or None,
        }
        own = self.http is None
        client = self.http or httpx.Client(timeout=TIMEOUT_S)
        try:
            r = client.post(self.url, json=payload)
            if r.status_code >= 400:
                log("alert.failed", id=record["id"], status=r.status_code)
            else:
                log("alert.sent", id=record["id"])
        except httpx.HTTPError as e:
            log("alert.failed", id=record["id"], error=type(e).__name__)
        finally:
            if own:
                client.close()
