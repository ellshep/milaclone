# Voice capture

Talk into your phone and the to-dos you mention show up in milaclone's Inbox.
A small service next to the app (`pipeline/`) turns a recording or a
transcript into tasks:

```
 iPhone Shortcut ──► https://mila.<tailnet>.ts.net/ingest/audio
 (Alexa, later) ──► https://mila.<tailnet>.ts.net/ingest/text
                         │ Tailscale sidecar
                         ▼
             pipeline (Python, 0.5 CPU / 256 MB cap)
   audio ─► queue ─► Deepgram Nova-3 (cloud) ───► transcript ─┐
   text ──────────────────────────────────────────► transcript ─┤
                                                                 ▼
                        LLM provider (EXTRACT_*) ─► tasks JSON ──┤
                                                                 ▼
                 POST http://app:4321/api/tasks  (dedupe, source=voice-note)
                                                                 ▼
                              Inbox to-do list (canvas + Quick notes)
```

- **Where your data goes.** Each recording is sent to Deepgram for
  transcription, and the transcript text to the LLM provider you configure.
  With `DEEPGRAM_MIP_OPT_OUT=true` (the default) Deepgram keeps no audio or
  transcript after replying; it logs only request metadata and usage. The audio
  file and transcript are also kept on the server in `ingest.db`.
- **Nothing is lost.** Every transcript, extraction result and outcome is
  stored in `ingest.db`, and the audio files are kept. If extraction fails
  twice, the transcript is kept and marked `extraction_failed`.
- **Audio uploads return at once** (`202`) and are processed one at a time in
  the background, in the order they arrived. Text ingests are
  answered straight away with the tasks they created, for a voice assistant to
  read back.
- **Duplicates are skipped:** a task whose title matches an open task is not
  created again (the task API's `dedupe`).

## Setup

1. Add to `.env` next to `docker-compose.yml`:

   ```bash
   echo "INGEST_API_TOKEN=$(openssl rand -hex 32)" >> .env
   # the task API token too, if you haven't set it yet (docs/task-api.md)
   echo "TASK_API_TOKEN=$(openssl rand -hex 32)" >> .env
   # the LLM that picks tasks out of the transcript, e.g. Anthropic:
   echo "EXTRACT_PROVIDER=anthropic" >> .env
   echo "EXTRACT_API_KEY=sk-ant-..." >> .env
   # speech-to-text for audio notes
   echo "DEEPGRAM_API_KEY=..." >> .env
   ```

2. `scripts/deploy.sh` (or `docker compose up -d --build`).
3. Check it: `curl -s https://mila.<tailnet>.ts.net/ingest/health`.

### Settings

| Variable               | Default              | Purpose                                                          |
| ---------------------- | -------------------- | ---------------------------------------------------------------- |
| `INGEST_API_TOKEN`     | unset (ingest off)   | Bearer token for `/ingest/*`. Separate from the task token       |
| `TASK_API_TOKEN`       | —                    | The app's task API token, used by the pipeline to add tasks      |
| `EXTRACT_PROVIDER`     | `anthropic`          | `anthropic`, `openai`, `gemini`, `openai_compatible`, `fake`     |
| `EXTRACT_MODEL`        | `claude-haiku-5-5`\* | Model for extraction. \*Only Anthropic has a default             |
| `EXTRACT_API_KEY`      | —                    | Provider API key (not needed for a local model)                  |
| `EXTRACT_BASE_URL`     | provider's own       | Required for `openai_compatible`, e.g. `http://ollama:11434/v1`  |
| `DEEPGRAM_API_KEY`     | —                    | Deepgram key for audio notes. Without it audio ingests fail      |
| `DEEPGRAM_MODEL`       | `nova-3`             | Deepgram's most accurate model for recorded audio                |
| `DEEPGRAM_LANGUAGE`    | `en`                 | `multi` for mixed languages; empty for Deepgram's default        |
| `DEEPGRAM_MIP_OPT_OUT` | `true`               | Deepgram keeps nothing after replying (may cost more per minute) |
| `TASK_TZ`              | `America/Chicago`    | Turns "tomorrow" or "next Friday" into dates                     |
| `MAX_AUDIO_MB`         | `50`                 | Largest accepted upload                                          |

Extraction uses the cheapest tier by default and asks for strict JSON. For
OpenAI and Gemini set `EXTRACT_MODEL` to that provider's smallest current
model. The `RANK_*` variables are reserved for the nightly ranking (later
phase), so the two steps can use different providers.

## Capture from the iPhone

Build a Shortcut called **Capture task**:

1. **Record Audio** (Audio Quality: Normal, Start Recording: Immediately,
   Finish Recording: On Tap).
2. **Get Contents of URL**:
   - URL: `https://mila.<your-tailnet>.ts.net/ingest/audio`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <INGEST_API_TOKEN>`
   - Request Body: **Form**, add a **File** field named `file` set to
     **Recorded Audio**.
3. Optional: **Show Notification** "Captured".

Add it to the Home Screen or the Action button, or say "Hey Siri, capture
task". The phone needs to be on Tailscale. The note is queued and the tasks
appear in the Inbox a few seconds to a minute later, depending on its length.

The same request works from anything that can POST a multipart file with that
header, such as a future ESP32 bedside button:

```bash
curl -sS https://mila.<tailnet>.ts.net/ingest/audio \
  -H "Authorization: Bearer $INGEST_API_TOKEN" \
  -F file=@note.m4a -F source=esp32
```

## Endpoints

All need `Authorization: Bearer $INGEST_API_TOKEN`, except the health check and
the review page (which asks for the token itself).

| Endpoint                    | Does                                                                            |
| --------------------------- | ------------------------------------------------------------------------------- |
| `POST /ingest/audio`        | Multipart `file` (+ optional `source`). `202 {id, status:"queued"}`             |
| `POST /ingest/text`         | `{"text": "...", "source": "alexa"}` or a text/plain body. Waits for the result |
| `GET /ingest/{id}`          | One ingest: status, transcript, summary, created and skipped tasks              |
| `GET /ingest/recent?limit=` | Latest ingests, newest first (max 200)                                          |
| `GET /ingest/review`        | A page listing recent ingests, to check the pipeline is getting it right        |
| `GET /ingest/health`        | `{ok, queued}`                                                                  |

A finished ingest also has `speech`, a sentence such as "Added Buy printer ink
and Call the dentist." for a voice assistant to read back.

Statuses: `queued` → `transcribing` → `extracting` → `done`, or
`extraction_failed` (transcript kept, no tasks), or `error` (transcription
failed, or the task API refused some tasks; `error` says which).

## Review

Open `https://mila.<tailnet>.ts.net/ingest/review`, paste the ingest token once
(it stays in that browser), and you see each note: what was heard, what it
became, and anything skipped or failed.

## Check transcription

Run one real recording through Deepgram the way the pipeline does, and see
the time and text:

```bash
docker compose cp ~/note-60s.m4a pipeline:/data/audio/bench.m4a
docker compose exec pipeline python bench.py /data/audio/bench.m4a
```

A 60-second note should come back in a few seconds. Record the numbers in
`HANDOFF-NOTES.md`.

## Backups

`ingest.db` lives in the `milaclone_ingest` volume. `scripts/deploy.sh` saves a
snapshot of it next to the board snapshot in `backups/` (`ingest-*.db`, newest 10) when the pipeline is running. By hand:

```bash
docker compose exec -T pipeline python -c "import sqlite3; d = sqlite3.connect('/tmp/i.db'); sqlite3.connect('/data/ingest.db').backup(d); d.close()"
docker compose cp pipeline:/tmp/i.db backups/ingest-manual.db
```

The audio files are in the same volume under `/data/audio` and are not pruned.

## Logs and troubleshooting

Every step writes one JSON line: `ingest.queued`, `ingest.transcribed`
(`audio_seconds`, `transcribe_ms`), `llm.call` (`provider`, `model`, token
counts, `latency_ms`), `ingest.done`, and the failures.

```bash
docker compose logs -f pipeline
docker compose logs pipeline | grep llm.call      # compare providers
```

- **401 from `/ingest/*`:** wrong `INGEST_API_TOKEN` in the Shortcut header.
  **503:** the token isn't set in `.env`.
- **Ingest ends in `error` with "TASK_API_TOKEN is not set" or "HTTP 401":**
  the pipeline's `TASK_API_TOKEN` doesn't match the app's. Both read the same
  `.env` line, so `docker compose up -d` after editing it.
- **`extraction_failed`:** the LLM call failed twice. The `error` field and
  `llm.error` log lines say why (bad key, wrong model name, provider down).
  The transcript is kept; re-send it with `POST /ingest/text`.
- **Audio ingest ends in `error` with "transcription failed":** the `error`
  field says why. "DEEPGRAM_API_KEY is not set" → add it to `.env` and
  `docker compose up -d`; "HTTP 401" → the key is wrong or revoked; "HTTP
  402" → out of Deepgram credits; "unreachable" → xbox can't reach
  `api.deepgram.com`. The audio file is kept; re-upload it once fixed.
- **`/ingest/...` returns the milaclone page or 404 over Tailscale:** check
  `docker compose exec tailscale tailscale serve status` shows `/ingest/`
  proxied to `pipeline:8000`.
