# Voice capture add-on

Say a to-do out loud and it lands in milaclone's Inbox, either as a voice note
recorded on your phone or by asking an Amazon Echo ("Alexa, tell my tasks to
add buy printer ink", or with Home Assistant, "Alexa, add buy printer ink to my
to-do list").

**Off by default.** Nothing in this folder runs, and none of its services start,
unless you switch it on. The board works the same without it.

## What's in here

| Part                     | What it is                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`pipeline/`](pipeline/) | A small Python service (its own container) that turns a recording or a sentence into tasks                                                                                                   |
| [`alexa/`](alexa/)       | A Cloudflare Worker that receives your private Alexa skill's requests and passes the text to the pipeline                                                                                    |
| [`docs/`](docs/)         | Setup and operation: [voice-capture.md](docs/voice-capture.md), [alexa.md](docs/alexa.md) (skill), [alexa-home-assistant.md](docs/alexa-home-assistant.md) (private, through Home Assistant) |

Both talk to the board only through the core [task API](../../docs/task-api.md),
which stays off until you set `TASK_API_TOKEN`.

## Before you turn it on

This add-on sends your data to third-party services. Decide whether that's
acceptable for you:

- **Recordings go to [Deepgram](https://deepgram.com)** for speech-to-text. By
  default the request asks Deepgram to keep nothing afterwards
  (`DEEPGRAM_MIP_OPT_OUT=true`). Words you list in `DEEPGRAM_KEYTERMS` are sent
  with each recording and do appear in Deepgram's usage records.
- **Transcripts go to the LLM provider you configure** (Anthropic by default;
  OpenAI, Gemini, or a local model through any OpenAI-compatible endpoint) to
  pick out the tasks, along with your existing tags and the titles of lists
  labelled Filing.
- **With the nightly ranking switched on** (`RANK_SCHEDULE=on`), the titles,
  due dates, list names and board titles of your open tasks, and your Home "Focus
  priorities" note, go to the ranking's LLM provider once a night
  ([details](docs/voice-capture.md#nightly-ranking)).
- **With Alexa,** Amazon hears what you say to the Echo. With the skill, the
  text also passes through Cloudflare, and one path of the pipeline is on the
  internet, behind Alexa's request signature, Cloudflare Access and a bearer
  token; see [docs/alexa.md](docs/alexa.md) for exactly what is exposed. The
  Home Assistant route ([docs/alexa-home-assistant.md](docs/alexa-home-assistant.md))
  exposes nothing: Home Assistant picks the item up from Alexa's to-do list.

Everything else stays on your server: the audio files, every transcript and
result (in the pipeline's own database), and your boards.

## Turn it on

In `.env` next to `docker-compose.yml`:

```bash
COMPOSE_PROFILES=voice     # phone voice notes
# COMPOSE_PROFILES=alexa   # the same, plus the Alexa skill (starts the Cloudflare Tunnel too)
#                          # (the Home Assistant Alexa route only needs voice)
```

then the settings in [docs/voice-capture.md](docs/voice-capture.md#setup)
(tokens and keys), and `docker compose up -d --build`.

## Turn it off

Remove the `COMPOSE_PROFILES` line from `.env`, then stop and remove the
add-on's containers:

```bash
docker compose --profile alexa rm -sf pipeline ranker cloudflared
```

The task API stays as it was; clear `TASK_API_TOKEN` to switch that off too. The `milaclone_ingest` volume keeps your past recordings
and transcripts until you remove it.

## Development

```bash
cd addons/voice/pipeline && pip install -r requirements-dev.txt && python -m pytest
cd addons/voice/alexa && npm ci && npm test
```

CI runs these in the **Voice add-on** workflow, only when this folder, the
compose file or the task API change.
