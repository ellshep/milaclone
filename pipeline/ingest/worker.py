"""One background thread that works through queued audio, one job at a time,
so uploads return at once and notes are processed in arrival order."""

from __future__ import annotations

import threading

from .logs import log
from .process import Deps, process_audio


class Worker:
    def __init__(self, deps: Deps, poll_seconds: float = 5.0):
        self.deps = deps
        self.poll_seconds = poll_seconds
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        n = self.deps.store.requeue_interrupted()
        if n:
            log("worker.requeued", count=n)
        self._thread = threading.Thread(target=self._run, name="ingest-worker", daemon=True)
        self._thread.start()

    def notify(self) -> None:
        self._wake.set()

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout)

    def run_once(self) -> bool:
        """Processes one queued job; returns False when the queue is empty."""
        job = self.deps.store.next_queued()
        if not job:
            return False
        try:
            process_audio(self.deps, job)
        except Exception as e:  # keep the worker alive whatever one job does
            self.deps.store.update(job["id"], status="error", error=f"unexpected: {e}")
            log("worker.job_crashed", id=job["id"], error=str(e))
            try:
                self.deps.alert(self.deps.store.get(job["id"]))
            except Exception:  # an alert must never stop the worker
                pass
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self.run_once():
                self._wake.wait(self.poll_seconds)
                self._wake.clear()
