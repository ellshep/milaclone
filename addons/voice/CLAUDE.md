# Voice add-on notes (`addons/voice/`)

Loaded when you work under `addons/voice/`. Optional and off by default: core code never imports from here, and everything reaches the board through the task API (`docs/task-api.md`). Overview in `README.md`, operation in `docs/voice-capture.md`, Alexa setup in `docs/alexa.md` (Worker) and `docs/alexa-home-assistant.md` (Home Assistant). 1,500-word cap (`npm run check:docs`).

CI: `.github/workflows/voice-addon.yml` runs on every PR. `Voice changes` decides from the PR's diff; `Pipeline tests` and `Alexa worker tests` run only when `addons/voice/`, `tailscale/`, the compose file, `tasks-api.js` or the app `Dockerfile` change, and skip (which counts as passing) otherwise. All three are required checks, so keep the job names and the path list in step.

## Pipeline (`pipeline/`, Python 3.12)

Its own Compose service and image behind the `voice` and `alexa` profiles. FastAPI app (`ingest/main.py`, started with `uvicorn ingest.main:create_app --factory`) behind `INGEST_API_TOKEN`.

- `POST /ingest/audio` stores the file and queues it (202). One `Worker` thread transcribes queued files one at a time with Deepgram's pre-recorded API (`transcribe.py` `DeepgramTranscriber`: raw POST to `/v1/listen` with `model=nova-3`, `smart_format`, `language`, `mip_opt_out`, and one `keyterm` per `DEEPGRAM_KEYTERMS` entry). Failures become the ingest's `error`; **the key never appears in messages**. There is no local speech model.
- A `TranscribeError` with `retryable` (network errors, 408/429/5xx) puts the job in `retrying` with `next_attempt_at` after each of `TRANSCRIBE_RETRY_DELAYS` (default 60,300,900 s); `store.next_queued` picks due retries.
- A final failure (non-retryable, retries used up, `extraction_failed`, task API errors, worker crash) calls `Deps.alert` once (`alerts.py` `Alerter`, POST to `ALERT_WEBHOOK_URL` with the reason and `INGEST_REVIEW_URL`, **never the transcript**).
- `POST /ingest/{id}/retry` (`process.reprocess`) re-runs extraction from a saved transcript, or re-queues saved audio when there is none.
- `POST /ingest/text` runs synchronously and returns `speech` for a voice assistant.
- `process.py` saves each step's output to `ingest.db` (`store.py`, rows never deleted) before the next runs, then posts each task to the app's `/api/tasks` with `dedupe: true` and `TASK_API_TOKEN`. New `ingest.db` columns are added at startup (`store.ADDED_COLUMNS`).
- Retention (N15): the worker thread runs `process.delete_old_audio` hourly. It deletes the audio of ingests `done` more than 7 days (`AUDIO_KEEP_DAYS`, by `updated_at`: only the sweep touches a done row again, and it skips rows it marked) and sets `audio_deleted_at`; failed ingests keep theirs, and rows stay.
- Extraction may only tag a task with tags already on the list: `extract_and_create` reads them through `TasksClient.existing_tags` (100 most used; on a task API error it extracts with none) and `extract.build_schema` puts them in an `enum`, so unknown tags are dropped. Filing lists work the same way (`TasksClient.filing_lists`, a task's `listName`): a task is posted with `listId` only when the model names a Filing list whose title no other Filing list shares.
- `llm.py` `complete_json` is the provider abstraction (anthropic via the official SDK; openai, gemini, openai_compatible via httpx; fake for tests), configured per step by `<STEP>_PROVIDER/_MODEL/_API_KEY/_BASE_URL` (`EXTRACT_*`, `RANK_*`; `max_tokens` and `timeout_s` are per step too). It validates against a pydantic model and retries once.
- The Anthropic client is built once per key (`_anthropic_client`), and `llm.preload` builds it in a background thread at startup: importing the SDK takes 7–9 s under the 0.5 CPU cap, longer than the Alexa Worker waits.
- Tests (`pipeline/tests`, pytest) inject fakes through `Deps`. The `Pipeline tests` job also checks the add-on is off without a profile, creates the compose containers and checks text → task end to end in Docker.
- `tailscale/serve.json` routes `/ingest/` to `pipeline:8000`.
- `ingest/rank.py` is the nightly ranking, its own Compose service `ranker` (voice profile, `restart: on-failure`, exits 0 unless `RANK_SCHEDULE=on`). It sends only the soon/starred/rest tiers, so fixed and placed tasks are never touched, and writes nothing unless every step worked: one `PUT /api/tasks/rank`. Each unset `RANK_*` falls back to `EXTRACT_*`, except the model, which defaults to Opus 5.5 with Anthropic. The same call files Inbox tasks (`inbox: true` in the focus view) into one Filing list (`rank.plan_moves`: at most `FILE_CAP` = 10 a night, never a task whose last move was the owner's); the moves ride in that PUT. Then it writes the "Filing log" document card on Home through board routes (`write_log`: newest run first, `LOG_RUNS` = 30; a document card stores `doc` and `text` itself, so `log_card` builds both, and only a card with `data.runs` counts as the log). A failed log write exits 1.

## Alexa (`alexa/`)

Its own npm package, deployed to Cloudflare with wrangler, not part of the Docker image.

- `src/worker.js` is the skill's HTTPS endpoint. `handle()` rate-limits, runs `src/verify.js` (`SignatureCertChainUrl` must be `https://s3.amazonaws.com/echo.api/…`, chain links and dates, SAN `echo-api.amazon.com`, `Signature-256` over the raw body, timestamp within 150 s, via `@peculiar/x509` + WebCrypto), checks the skill ID, then forwards `AddTaskIntent`'s `task` slot to exactly one URL, the pipeline's `/ingest/text` (`source: alexa`), and speaks the returned `speech`. On any failure it says the task wasn't added.
- Deploy settings are passed as `wrangler deploy --var INGEST_URL:… --var SKILL_ID:…` so the server's checkout stays unmodified.
- The path to the server is a Cloudflare Tunnel (`cloudflared` Compose service, pinned image, profile `alexa`, token in `.env`); its hostname, single path and Access service-token policy live in the Cloudflare dashboard.
- `skill/interaction-model.json` is pasted into the Alexa console.
- A second, no-code route needs no Worker or tunnel: Home Assistant's Alexa Devices integration (2026.7+) exposes Alexa's to-do list, and a Home Assistant automation posts each new item to `/ingest/text` over the local network and removes it from the list (`docs/alexa-home-assistant.md`; only docs live in the repo, the YAML runs in Home Assistant).
- Tests: `cd addons/voice/alexa && npm test` (node:test with a made-up certificate chain); the `Alexa worker tests` job also dry-run bundles with wrangler.

## Env vars

Only read when `COMPOSE_PROFILES` includes `voice` or `alexa`: `INGEST_API_TOKEN`, `TASK_API_TOKEN`, `APP_URL`, `EXTRACT_*`, `RANK_*` (`_SCHEDULE`, `_NUDGE`, `_PROVIDER`, `_MODEL`, `_API_KEY`, `_BASE_URL`), `DEEPGRAM_API_KEY`/`_MODEL`/`_LANGUAGE`/`_MIP_OPT_OUT`/`_KEYTERMS`, `TRANSCRIBE_RETRY_DELAYS`, `ALERT_WEBHOOK_URL`, `INGEST_REVIEW_URL`, `TASK_TZ`, `MAX_AUDIO_MB`. Data lives in the `milaclone_ingest` volume.
