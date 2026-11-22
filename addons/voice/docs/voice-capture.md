# Voice capture

Talk into your phone and the to-dos you mention show up in milaclone's Inbox.
A small service next to the app (`addons/voice/pipeline/`) turns a recording or a
transcript into tasks:

```
 iPhone Shortcut ──► https://mila.<tailnet>.ts.net/ingest/audio
 Alexa ────────────► /ingest/text  (alexa.md, alexa-home-assistant.md)
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
  transcript after replying; it logs only request metadata and usage. The
  transcript is also kept on the server in `ingest.db`, and the audio file
  until 7 days after the note is processed.
- **Nothing is lost.** Every transcript, extraction result and outcome is
  stored in `ingest.db`. A note's audio file is deleted 7 days after it is
  processed (the record shows `audioDeletedAt`); a failed note keeps its audio
  for a retry. If extraction fails twice, the transcript is kept and marked
  `extraction_failed`.
- **Audio uploads return at once** (`202`) and are processed one at a time in
  the background, in the order they arrived. Text ingests are
  answered straight away with the tasks they created, for a voice assistant to
  read back.
- **Duplicates are skipped:** a task whose title matches an open task is not
  created again (the task API's `dedupe`).

## Setup

1. Add to `.env` next to `docker-compose.yml`:

   ```bash
   # switch the add-on on (it is off by default)
   echo "COMPOSE_PROFILES=voice" >> .env
   echo "INGEST_API_TOKEN=$(openssl rand -hex 32)" >> .env
   # the task API token too, if you haven't set it yet (see docs/task-api.md)
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

| Variable                  | Default              | Purpose                                                                                          |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `INGEST_API_TOKEN`        | unset (ingest off)   | Bearer token for `/ingest/*`. Separate from the task token                                       |
| `TASK_API_TOKEN`          | —                    | The app's task API token, used by the pipeline to add tasks                                      |
| `EXTRACT_PROVIDER`        | `anthropic`          | `anthropic`, `openai`, `gemini`, `openai_compatible`, `fake`                                     |
| `EXTRACT_MODEL`           | `claude-haiku-5-5`\* | Model for extraction. \*Only Anthropic has a default                                             |
| `EXTRACT_API_KEY`         | —                    | Provider API key (not needed for a local model)                                                  |
| `EXTRACT_BASE_URL`        | provider's own       | Required for `openai_compatible`, e.g. `http://ollama:11434/v1`                                  |
| `DEEPGRAM_API_KEY`        | —                    | Deepgram key for audio notes. Without it audio ingests fail                                      |
| `DEEPGRAM_MODEL`          | `nova-3`             | Deepgram's most accurate model for recorded audio                                                |
| `DEEPGRAM_LANGUAGE`       | `en`                 | `multi` for mixed languages; empty for Deepgram's default                                        |
| `DEEPGRAM_MIP_OPT_OUT`    | `true`               | Deepgram keeps nothing after replying (may cost more per minute)                                 |
| `DEEPGRAM_KEYTERMS`       | unset                | Comma-separated names and jargon to listen for, e.g. `Claude,Tailscale` (nova-3 only; see below) |
| `TRANSCRIBE_RETRY_DELAYS` | `60,300,900`         | Seconds before each retry when Deepgram is busy or down; empty = none                            |
| `ALERT_WEBHOOK_URL`       | unset (no alerts)    | Gets one POST per note that failed for good                                                      |
| `INGEST_REVIEW_URL`       | unset                | Link put in the alert, e.g. the review page                                                      |
| `TASK_TZ`                 | `America/Chicago`    | Turns "tomorrow" or "next Friday" into dates                                                     |
| `MAX_AUDIO_MB`            | `50`                 | Largest accepted upload                                                                          |

`DEEPGRAM_KEYTERMS` uses Deepgram's
[keyterm prompting](https://developers.deepgram.com/docs/keyterm): it helps with
names the model mishears, such as "claw" for Claude or "tail scale" for
Tailscale. Write proper nouns capitalised as you want them to appear. Deepgram
takes up to 100 terms and 500 tokens in all, but works best with the 20 to 50
that matter most; skip common words it already gets right. A list over the limit
makes every audio note fail with a Deepgram error, which the alert reports.
Deepgram keeps the terms in its usage records even with `DEEPGRAM_MIP_OPT_OUT`,
so leave out anything you would not want stored there.

Extraction uses the cheapest tier by default and asks for strict JSON. For
OpenAI and Gemini set `EXTRACT_MODEL` to that provider's smallest current
model. The nightly ranking has its own `RANK_*` settings (below), so the two
steps can use different providers.

Tags: before each extraction the pipeline reads the tags already on your task
list (`GET /api/tasks?status=all`, the 100 most used), and the model may only
give a task some of those. They are listed in the prompt and, for Anthropic
and OpenAI, enforced by the JSON schema; any other tag is dropped. New tags
only come from you, on the board. With no tags on the list yet, tasks get none.
If the task API can't be read, extraction runs without tags.

Filing: label a to-do list **Filing** on the board and a voice note can send a
task straight to it, but only when you name the list for that task ("put
'post the parcel' on Errands"). The pipeline reads the Filing lists'
titles (`GET /api/tasks/lists?label=Filing`) and the model may only pick one of
them, or none; a task with no list named, a name that isn't a Filing list, or
a title two Filing lists share goes to the Inbox. Lists under the Templates
board are never offered. If the lists can't be read, every task goes to the
Inbox.

## Nightly ranking

The `ranker` service (voice profile, same image) orders the focus page's open
tasks once a night at 03:00 in `TASK_TZ`. It reads the focus order and the Home
note whose first line is "Focus priorities" through the task API, asks the
model for a score (0–100), a one-line reason and a few one-tier moves for each
task in the soon, starred and rest tiers, and writes them back in one
`PUT /api/tasks/rank`. Overdue, due-today and hand-placed tasks are never sent
or changed. Only the first 200 of those tasks, in the current order, are sent,
so the answer fits the model's output limit; the rest keep their last score
(their moves are cleared). If anything fails, nothing is written and the fixed
order stays.

It sends the model each ranked task's title, due date, list and board titles,
plus the whole Focus priorities note.

Nightly filing: when there are lists labelled **Filing** (see Filing above), the
same model call may file Inbox tasks into the one Filing list that clearly
fits, with a reason, at most 10 a night. Only Inbox tasks sent for ranking are
considered (the first 40 of them), so overdue, due-today and hand-placed Inbox
tasks never are. The moves are written in the same `PUT`, so they land with the
ranking or not at all, and the app skips a move whose task changed since it was
read. Each is recorded on the task (`movedBy: "ranker"`, `movedFrom` = the
Inbox). A task whose last move was anyone else's (sent back to the Inbox through
the task API, by an agent or by you) is never filed again; a task deleted and
typed again is a new task and can be.

Each run then writes the **Filing log**, a document card on Home: the run's time
and, for every Inbox task it considered, where it moved or why it stayed. Newest
run first, the last 30 kept. The dry run prints the planned moves as
`→ List: task - reason` and the log entry it would write, and writes neither.

To undo a move: "Back to Inbox" comes with the focus page's row menu (F4.3 in
`docs/focus-redesign.md`). Until then, move it back with the task API, using the
task's id and its `movedFrom` (both in `GET /api/tasks`):

```bash
curl -sS -X PATCH "https://mila.<tailnet>.ts.net/api/tasks/<task id>" \
  -H "Authorization: Bearer $TASK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"listId": "<its movedFrom>"}'
```

| Variable        | Default                                             | Purpose                                                                 |
| --------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `RANK_SCHEDULE` | `off`                                               | `on` ranks nightly; off, the service exits at once                      |
| `RANK_NUDGE`    | `one-tier`                                          | `off` (no moves), `one-tier` (at most 3 a night), `free`                |
| `RANK_PROVIDER` | `EXTRACT_PROVIDER`                                  | Same choices as extraction                                              |
| `RANK_MODEL`    | `claude-opus-5-5` (Anthropic), else `EXTRACT_MODEL` | Asked at low effort; roughly $3 a month per 100 ranked tasks (estimate) |
| `RANK_API_KEY`  | `EXTRACT_API_KEY`                                   | Provider key                                                            |
| `RANK_BASE_URL` | `EXTRACT_BASE_URL`                                  | For `openai_compatible`                                                 |

See what it would do first. The dry run calls the model once and prints each
score, reason and move with the top three before and after, and writes nothing:

```bash
docker compose run --rm ranker python -m ingest.rank --dry-run
```

If it looks right, add `RANK_SCHEDULE=on` to `.env` and `docker compose up -d`.
An invalid `TASK_TZ` stops the service with a `rank.bad_tz` log line instead of
scheduling.
Each night logs one `rank.done` line (tokens, `cost_usd` for known models, the
top three before and after) or a `rank.failed` line:
`docker compose logs ranker | grep rank.`

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
| `POST /ingest/{id}/retry`   | Run a failed note again from what was saved (see "When something fails")        |
| `GET /ingest/recent?limit=` | Latest ingests, newest first (max 200)                                          |
| `GET /ingest/review`        | A page listing recent ingests, to check the pipeline is getting it right        |
| `GET /ingest/health`        | `{ok, queued, retrying}`                                                        |

A finished ingest also has `speech`, a sentence such as "Added Buy printer ink
and Call the dentist." for a voice assistant to read back.

Statuses: `queued` → `transcribing` → `extracting` → `done`, or
`retrying` (Deepgram was busy or down; another try is scheduled), or
`extraction_failed` (transcript kept, no tasks), or `error` (transcription
failed for good, or the task API refused some tasks; `error` says which).

## When something fails

A failed note keeps its audio file until it succeeds, and every transcript stays
on the server whatever happens. Audio is deleted only 7 days after a note
finished.

- **Deepgram busy, down or unreachable** (timeouts, network errors, HTTP 408,
  429 and 5xx): the note goes to `retrying` and is tried again after 1, 5
  and 15 minutes (`TRANSCRIBE_RETRY_DELAYS`). Other notes keep flowing in
  the meantime. A restart of the server also resumes it.
- **Problems that won't fix themselves** (no or wrong key, HTTP 401/403, out
  of credits, HTTP 402, a file Deepgram can't read): the note fails at once,
  without retries.
- **After the last retry, a failure that won't fix itself, or the LLM or the
  task list failing:** the note is marked failed and you get **one alert**
  (below).

To run a failed note again once the cause is fixed, press **Retry** on the
review page, or:

```bash
curl -s -X POST -H "Authorization: Bearer $INGEST_API_TOKEN" \
  https://mila.<tailnet>.ts.net/ingest/<id>/retry
```

If the note was transcribed but extraction or task creation failed, only those
steps run again (no new Deepgram call), and tasks already added are skipped as
duplicates. If transcription never succeeded, the saved audio goes back in the
queue (`202`). A note still waiting to retry can be retried right away the
same way.

### Failure alert on your phone

Set `ALERT_WEBHOOK_URL` and every note that finally fails sends one POST:

```json
{
  "event": "ingest.failed",
  "id": "g_…",
  "kind": "audio",
  "source": "voice-note",
  "status": "error",
  "error": "transcription failed after 4 attempts: Deepgram HTTP 503: …",
  "message": "Voice note wasn't added: transcription failed after 4 attempts: …",
  "review_url": "https://mila.<tailnet>.ts.net/ingest/review"
}
```

It carries the reason and a link, never the transcript. With Home Assistant:

1. Make an automation with a **Webhook** trigger, ID
   `milaclone-ingest-failed`, **local only**, and a **Notify** action to your
   phone with message `{{ trigger.json.message }}`. Optionally make the
   notification open `{{ trigger.json.review_url }}`.
2. In `.env`:

   ```bash
   ALERT_WEBHOOK_URL=http://host.docker.internal:8123/api/webhook/milaclone-ingest-failed
   INGEST_REVIEW_URL=https://mila.<tailnet>.ts.net/ingest/review
   ```

   `host.docker.internal` is the server itself as seen from the pipeline
   container. Then `docker compose up -d`.

3. Check it reaches Home Assistant:

   ```bash
   docker compose exec pipeline python -c "import httpx,os; print(httpx.post(os.environ['ALERT_WEBHOOK_URL'], json={'message':'test from milaclone'}).status_code)"
   ```

   It should print `200` and buzz your phone. If it times out, the firewall is
   blocking containers from reaching the host; allow it with
   `sudo ufw allow from 172.16.0.0/12 to any port 8123 proto tcp`.

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

A 60-second note should come back in a few seconds.

## Backups

`ingest.db` lives in the `milaclone_ingest` volume. `scripts/deploy.sh` saves a
snapshot of it next to the board snapshot in `backups/` (`ingest-*.db`, newest 10) when the pipeline is running. By hand:

```bash
docker compose exec -T pipeline python -c "import sqlite3; d = sqlite3.connect('/tmp/i.db'); sqlite3.connect('/data/ingest.db').backup(d); d.close()"
docker compose cp pipeline:/tmp/i.db backups/ingest-manual.db
```

The audio files are in the same volume under `/data/audio`. The worker checks
hourly and deletes each one 7 days after its note finished (`audio.deleted` in
the logs); failed notes keep theirs.

## Logs and troubleshooting

Every step writes one JSON line: `ingest.queued`, `ingest.transcribed`
(`audio_seconds`, `transcribe_ms`), `llm.call` (`provider`, `model`, token
counts, `latency_ms`), `ingest.done`, and the failures. At startup,
`llm.preloaded` (`ms`) says the Anthropic SDK has loaded; a note that arrives
in the first few seconds after a restart waits for it.

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
  402" → out of Deepgram credits; "unreachable" → the server can't reach
  `api.deepgram.com`. The audio file is kept; re-upload it once fixed.
- **`/ingest/...` returns the milaclone page or 404 over Tailscale:** check
  `docker compose exec tailscale tailscale serve status` shows `/ingest/`
  proxied to `pipeline:8000`.
