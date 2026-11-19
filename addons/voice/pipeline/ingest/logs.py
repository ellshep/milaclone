"""One JSON object per log line on stdout, so `docker compose logs` greps well."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone


def log(event: str, **fields) -> None:
    rec = {"event": event, "at": datetime.now(timezone.utc).isoformat(timespec="milliseconds")}
    rec.update({k: v for k, v in fields.items() if v is not None})
    print(json.dumps(rec, default=str), file=sys.stdout, flush=True)
