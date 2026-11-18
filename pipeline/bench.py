"""Time faster-whisper on an audio file, the way the pipeline runs it.

Inside the running container (uses its model cache and CPU limits):
  docker compose exec pipeline python bench.py /data/audio/<file>.m4a
Or generate a clip first, e.g. record 60 s on the phone and copy it in.
"""

from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from ingest.transcribe import WhisperTranscriber


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio", type=Path)
    p.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "base"))
    p.add_argument("--threads", type=int, default=int(os.environ.get("WHISPER_THREADS", "2")))
    p.add_argument("--compute-type", default=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"))
    p.add_argument("--models-dir", type=Path, default=Path(os.environ.get("WHISPER_MODELS_DIR", "/models")))
    a = p.parse_args()

    t = WhisperTranscriber(a.model, a.threads, a.compute_type, a.models_dir)
    start = time.monotonic()
    t._load()
    load_s = time.monotonic() - start
    result = t.transcribe(a.audio)
    secs = result.elapsed_ms / 1000
    print(f"model={a.model} threads={a.threads} compute={a.compute_type}")
    print(f"load: {load_s:.1f} s (first run includes the download)")
    print(f"audio: {result.audio_seconds:.1f} s, transcribed in {secs:.1f} s "
          f"({result.audio_seconds / secs if secs else 0:.1f}x real time)")
    print(f"text: {result.text[:300]}")


if __name__ == "__main__":
    main()
