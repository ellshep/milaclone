"""Transcribe one audio file with Deepgram, the way the pipeline does, and time it.

Inside the running container (uses its DEEPGRAM_* settings):
  docker compose exec pipeline python bench.py /data/audio/<file>.m4a
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ingest.config import Settings
from ingest.transcribe import DeepgramTranscriber, TranscribeError


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("audio", type=Path)
    p.add_argument("--model", help="override DEEPGRAM_MODEL (default nova-3)")
    a = p.parse_args()

    s = Settings.from_env()
    t = DeepgramTranscriber(s.deepgram_api_key, a.model or s.deepgram_model, s.deepgram_language,
                            s.deepgram_mip_opt_out)
    try:
        result = t.transcribe(a.audio)
    except TranscribeError as e:
        sys.exit(f"error: {e}")
    secs = result.elapsed_ms / 1000
    print(f"model={t.model} language={t.language or 'auto'} keep-nothing={t.mip_opt_out}")
    print(f"audio: {result.audio_seconds:.1f} s, transcribed in {secs:.1f} s")
    print(f"text: {result.text[:500]}")


if __name__ == "__main__":
    main()
