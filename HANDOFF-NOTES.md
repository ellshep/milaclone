# Handoff notes: voice task capture

Running log for the voice task capture work (task API, voice pipeline, Alexa,
focus view, daily resurfacing). One entry per phase: what was built, what was
verified, what is left and what needs the owner's input.

## Discovery (before Phase 1)

What the repo actually is, against the assumptions in the original handoff:

- **Stack:** Node 22, Express 4, `better-sqlite3`. `server.js` → `routes.js` →
  `db.js`; routes call prepared statements directly. Vanilla ES-module
  frontend, no framework.
- **Database:** SQLite at `DATA_DIR/board.db`, WAL mode already on. Backups:
  `GET /api/backup` streams a snapshot, and `scripts/deploy.sh` saves one to
  `backups/` before every redeploy.
- **To-do model:** there is no tasks table. A task is an entry in
  `items.data.tasks` of a `todo` card: `{ id, text, done, starred, due
(YYYY-MM-DD), tags[], note, noteStyle, createdAt, indent }`. Quick notes (the
  mobile to-do screen) lists every todo card on every board. Tags are free
  strings with no registry. There is no priority field; the star is the
  closest thing.
- **Concurrency:** both clients send the list they last loaded (`baseTasks`)
  and the server does a three-way merge (`routes.js` `mergeTasks`), so tasks
  added by another writer survive, and fields a client doesn't know are kept.
- **Auth:** none. The app trusts the tailnet.
- **Deploy:** Docker Compose project `milaclone`: `app` on `127.0.0.1:8182`
  (0.5 CPU, 256 MB) plus a Tailscale sidecar serving
  `https://mila.<tailnet>.ts.net`. `.env` (gitignored) holds `TS_AUTHKEY`.

## Phase 1: task creation API

**Built**

- `tasks-api.js`: `POST /api/tasks`, `GET /api/tasks?status=`,
  `PATCH /api/tasks/:id`, behind `Authorization: Bearer $TASK_API_TOKEN`
  (constant-time compare; an unset token switches the API off with 503 rather
  than leaving it open). Reference: `docs/task-api.md`.
- New tasks go to an **Inbox** to-do card on Home, created on first use and
  recreated if it is trashed (owner decision). `listId` targets another list.
- **Priority is the star** (owner decision): `priority: "high"` or
  `starred: true`.
- The handoff's new columns are stored as camelCase task fields, matching the
  existing JSON: `source`, `pinned`, `stale`, `rankScore`, `rankReason`,
  `rankedAt`, `importId`. No schema migration is needed now or in later
  phases.
- Server-side dedupe (`dedupe: true` skips an open task with the same title)
  and `importId` idempotency, so the pipeline and the Microsoft To Do import
  share one implementation.
- One JSON log line per create, skip and update, including `source`.
- `.env.example`, compose env vars, README section, CLAUDE.md.

**Verified**

- `test/tasks.api.test.js` (13 tests): auth failures, disabled API, happy
  path through to `GET /api/todos`, Inbox recreation, `listId`, 23 validation
  cases, due-date time zone conversion, priority → star, importId, dedupe,
  listing order and filters, PATCH, and a stale client save keeping an
  API-added task. `tasks-api.js` coverage: 99% lines, 96% branches.
- Full `npm test`, lint, format and UI unit tests pass. Chromium e2e: 123 of
  126 pass here; the same 3 fail without these changes (the sandbox blocks the
  Lucide icon CDN), so CI is the reference.
- Manual: real server plus `curl`. Tasks showed in the Inbox card on the
  canvas and in Quick notes.

**Not verified on xbox yet.** Owner steps:

1. `echo "TASK_API_TOKEN=$(openssl rand -hex 32)" >> .env` next to
   `docker-compose.yml`, then `scripts/deploy.sh` (or `docker compose up -d --build`).
2. Run the `curl` example in `docs/task-api.md` against
   `https://mila.<tailnet>.ts.net`.

## Phase 2: voice note to tasks pipeline

**Built**

- `pipeline/`: a Python 3.12 FastAPI service in its own Compose service
  (`pipeline`, loopback `127.0.0.1:8183`, capped at 1 CPU / 1 GB), served on
  the tailnet at `https://mila.<tailnet>.ts.net/ingest/` through the existing
  Tailscale sidecar. Reference: `docs/voice-capture.md`.
- `POST /ingest/audio` stores the upload and queues it (202). One background
  worker transcribes with faster-whisper on the CPU (`WHISPER_MODEL`, default
  `base`, int8), one job at a time. `POST /ingest/text` runs synchronously and
  returns the created tasks plus a `speech` sentence for Alexa later.
- Every transcript, extraction result, created and skipped task, and error is
  kept in `ingest.db` (volume `milaclone_ingest`), with the audio files.
  `scripts/deploy.sh` snapshots `ingest.db` next to the board backup.
- LLM provider abstraction (`pipeline/ingest/llm.py`): `complete_json` with
  per-step config (`EXTRACT_*` now, `RANK_*` reserved for Phase 4). Providers:
  Anthropic (official SDK, structured outputs, default model
  `claude-haiku-5-5` at low effort), OpenAI (strict JSON schema), Gemini (JSON
  mode), any OpenAI-compatible local endpoint such as Ollama, and `fake`.
  Answers are validated with pydantic and retried once; after that the
  transcript is kept as `extraction_failed`. Every call logs provider, model,
  token counts and latency.
- Tasks go through the Phase 1 API with `source: voice-note` and
  `dedupe: true`, so the duplicate rule lives in one place.
- Review: `GET /ingest/recent` (JSON) and `/ingest/review` (a page that asks
  for the token once and lists each note with what it became).
- iOS Shortcut steps in `docs/voice-capture.md`. The audio endpoint takes a
  plain multipart `file` (+ optional `source`), so an ESP32 recorder can use it
  unchanged.
- CI: new `Pipeline tests` job (not a required check). It runs pytest, builds
  both images and checks text → task end to end in Docker.

**Verified here**

- `pytest`: 35 tests, 95% coverage of `ingest/` (the Whisper wrapper is the
  uncovered part; it needs the real model). Covers auth, the audio queue and
  worker, the synchronous text path, duplicates, extraction and task-API
  failures, restart recovery, upload limits, and each provider's request and
  response handling against mocked HTTP.
- Ran the real app and the pipeline together (fake LLM): a text ingest created
  two Inbox tasks, a repeat was skipped as a duplicate, and an audio upload was
  queued and processed by the worker.
- **Not verified here:** real transcription and the benchmark. This sandbox
  can't download the Whisper model (Hugging Face is blocked) and has no Docker
  daemon, so the image build is first checked in CI.

**Needs the owner**

1. Pick the first LLM provider and key (open question from the handoff).
   Anthropic is the default; put `EXTRACT_API_KEY` in `.env`. Use a fresh key
   scoped to this project.
2. Add `INGEST_API_TOKEN` to `.env` and redeploy.
3. Run the benchmark on xbox with a 60-second clip
   (`docker compose exec pipeline python bench.py …`, see the doc), try `base`
   and `small`, then set `WHISPER_MODEL` and adjust the 1 CPU / 1 GB cap.
   Record the numbers here.
4. Build the iOS Shortcut and send a few real notes. Check `/ingest/review`
   before relying on it.

**Still open before Phase 3**

- AWS / Alexa developer account, or the Home Assistant route?
- Morning digest time, and whether weekends differ.
- Tags: let the model assign them freely (current behaviour: only when the
  speaker names a category), or limit them to an allowlist of existing tags?

## Phase 3: Alexa voice capture

**Decided with the owner:** accounts available are an Alexa developer account,
AWS and Cloudflare (no Home Assistant Cloud); route is a **Cloudflare Worker +
Cloudflare Tunnel**; tags stay "only when spoken". The routes weighed and why
are in `docs/alexa.md`.

**Built**

- `alexa/`: the skill's endpoint as a Cloudflare Worker. It verifies Alexa's
  request signature and the skill ID, rate limits, and forwards the spoken
  task to the pipeline's `/ingest/text` only, then has Alexa read back the
  pipeline's answer ("Added Buy printer ink."). Failures are spoken as
  failures.
- `alexa/skill/interaction-model.json`: invocation name "my tasks", an
  `AddTaskIntent` with phrasings such as "add …", "remind me to …", "I need
  to …".
- `cloudflared` Compose service (profile `alexa`, off by default, capped at
  0.25 CPU / 128 MB): an outbound-only tunnel. The hostname, its single
  allowed path and the Access service-token policy are set in the Cloudflare
  dashboard.
- `docs/alexa.md`: the exact steps in the Cloudflare dashboard, the Alexa
  developer console and on the server, plus troubleshooting.
- CI: new `Alexa worker tests` job (not required).

**Verified here**

- 9 Worker tests against a made-up certificate chain: the happy path, every
  intent, pipeline failures, and refusals (wrong skill, wrong or missing
  signature, tampered body, non-Amazon certificate URLs, wrong-name, expired
  and broken certificates, stale timestamps, rate limit, missing settings).
- The Worker bundles with wrangler and runs in Cloudflare's local runtime,
  where it refused unsigned requests as expected.
- **Not verified here:** a real Alexa request (Amazon's real certificate and
  signature), the tunnel, Access, and the skill on an Echo. All need the
  owner's accounts.

**Needs the owner** (steps in `docs/alexa.md`)

1. Deploy the Phase 2 pipeline on xbox first, if not done (LLM key, tokens).
2. Create the tunnel and its hostname, the Access service token and policy.
3. `npx wrangler deploy` and the three secrets.
4. Create the skill, paste the interaction model, set the endpoint, copy the
   skill ID into `wrangler.toml`, redeploy, enable Development testing.
5. Say "Alexa, tell my tasks to add buy printer ink" and check the Inbox.

**Still open before Phase 5:** morning digest time, and whether weekends differ.

## Change: Deepgram replaces local Whisper (owner decision)

The owner chose Deepgram for speech-to-text (they have credits), replacing
local faster-whisper. This reverses the original "audio never leaves the
server" decision on purpose.

- Model **Nova-3** (Deepgram's most accurate model for recorded audio; Flux
  is for live streaming conversations), with smart formatting and
  `language=en`.
- `mip_opt_out=true` by default: Deepgram keeps no audio or transcript after
  replying, which may be billed at a higher per-minute rate.
- Whisper removed entirely (owner's choice): no local fallback, a much
  smaller image, the `milaclone_models` volume is no longer used, and the
  pipeline's cap drops to 0.5 CPU / 256 MB. The Whisper benchmark step is
  replaced by a one-file check (`bench.py`) in `docs/voice-capture.md`.
- Owner steps: put `DEEPGRAM_API_KEY` in `.env`, then `docker compose up -d`
  once the change is deployed. Optionally remove the old model volume with
  `docker volume rm milaclone_milaclone_models` (check the name with
  `docker volume ls`).

## Change: retries, reprocess and failure alerts for voice notes

Asked for by the owner after moving transcription to Deepgram.

- **Retries:** a transcription failure that may clear up by itself
  (timeouts, network errors, HTTP 408/429/5xx) is retried after 1, 5 and 15
  minutes (`TRANSCRIBE_RETRY_DELAYS`). A wrong key (401/403), no credits
  (402) or an unreadable file fails at once. Other notes keep flowing while
  one waits.
- **Reprocess:** `POST /ingest/{id}/retry` and a Retry button on the review
  page. With a saved transcript only extraction and task creation run again
  (no new Deepgram call; tasks already added are skipped as duplicates);
  otherwise the saved audio is queued again.
- **Failure alert:** one POST per note that finally fails, to
  `ALERT_WEBHOOK_URL` (a Home Assistant webhook), with the reason and a link
  to the review page, never the transcript. The pipeline container reaches
  the host as `host.docker.internal`.
- `ingest.db` gains two columns (`attempts`, `next_attempt_at`), added
  automatically at startup to the existing database.
- Owner steps: create the Home Assistant webhook automation, set
  `ALERT_WEBHOOK_URL` and `INGEST_REVIEW_URL` in `.env`, `docker compose up -d`,
  and run the test command in `docs/voice-capture.md` ("Failure alert on your
  phone"). If it times out, allow the Docker network through UFW to port 8123.

## Fix: slow first extraction after a restart

Found during setup on xbox: the first voice note after a deploy took 11.5 s to
extract; the next took 2.9 s.

- **Cause:** `_call_anthropic` imported the Anthropic SDK on first use, and
  `complete_json` times the call including it. The import costs about 3.6 s of
  CPU, 7–9 s under the pipeline's 0.5 CPU cap. Structured-output schema
  compilation adds only about 1 s, the first time a schema is used in 24 h.
  The model is not slow: warm extraction takes about 2 s, and turning thinking
  off made no difference.
- **Why it mattered:** `/ingest/text` shares the path and the Alexa Worker
  waits 6.5 s, so the first Alexa request after each deploy would time out.
- **Fix:** `llm.preload` imports the SDK and builds one shared client per key
  in a background thread at startup (`llm.preloaded` log line). Calls reuse
  that client and its connections. Thinking and the JSON schema are unchanged.
- **Measured** in a throwaway container with the same 0.5 CPU cap and the
  real key: first extraction 7.72 s → 1.61 s (preload finished 4.9 s after
  start, before any request); second extraction 1.41 s → 1.46 s.

## Plan: the next phases (owner decisions)

Phases 4 and 5 of the handoff were re-planned with the owner on 2026-11-20,
together with list filing, a Pebble watch app and a Microsoft To Do backlog
import. The decisions and the work items are in `docs/next-phases.md`; where it
differs from the handoff (no polling, a fixed stale rule, Opus for ranking,
owner ordering instead of a pin button, Home Assistant running the digest), it
is the newer decision.
