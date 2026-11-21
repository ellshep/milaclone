# Alexa through Home Assistant (private)

"Alexa, add buy printer ink to my to-do list" puts _Buy printer ink_ in
milaclone's Inbox. Nothing on your server faces the internet, and there is no
skill, Worker, tunnel or domain to set up: Alexa's own to-do list is the
hand-off, and Home Assistant moves each new item to the pipeline.

```
 Echo ─► Alexa cloud ─► Alexa's built-in to-do list
                           │ pushed to Home Assistant (Alexa Devices integration)
                           ▼
              Home Assistant automation (on your network)
                           │ POST http://127.0.0.1:8183/ingest/text  (bearer token)
                           ▼
              pipeline /ingest/text  (voice-capture.md) ─► task API ─► Inbox
                           │
                           └─► removes the item from Alexa's list
```

The text goes through the same extraction and duplicate check as a voice note,
so "call the dentist tomorrow" gets tomorrow's date, and a task already on the
list isn't added twice.

## This route or the skill?

|                         | Through Home Assistant (this page)                                                         | Alexa skill ([alexa.md](alexa.md))                              |
| ----------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| What faces the internet | Nothing new                                                                                | A Cloudflare Worker, plus one tunnel path behind Access         |
| What you need           | Home Assistant 2026.7 or later with Alexa Devices                                          | A Cloudflare account with a domain, an Amazon developer account |
| Code to deploy          | None (Home Assistant YAML)                                                                 | The Worker in `addons/voice/alexa/`                             |
| What you say            | "Alexa, add … to my to-do list"                                                            | "Alexa, tell my tasks to add …"                                 |
| What Alexa answers      | Its own "Added … to your to-do list" (optionally followed by milaclone's reply, see below) | milaclone's reply: "Added Buy printer ink."                     |
| Main risk               | Alexa Devices uses Amazon's private API, which Amazon can change                           | More moving parts to keep working                               |

You don't need `COMPOSE_PROFILES=alexa` or the `cloudflared` service for this
route; `COMPOSE_PROFILES=voice` is enough.

What leaves the house: Amazon hears the phrase and keeps it on your Alexa list
until Home Assistant removes it (as with anything said to an Echo), and the
pipeline sends the text to the LLM provider you configured.

## Setup

You need the voice pipeline running ([voice-capture.md](voice-capture.md)) and
Home Assistant **2026.7 or later** with the
[Alexa Devices](https://www.home-assistant.io/integrations/alexa_devices/)
integration signed in to the same Amazon account as your Echo. That release
added Alexa's to-do and shopping lists as Home Assistant to-do entities.

These steps assume Home Assistant runs on the same machine as milaclone, so it
reaches the pipeline at `127.0.0.1:8183` (the compose file publishes it there,
loopback only). If Home Assistant runs elsewhere, point the URL at the
pipeline's Tailscale address instead (`https://mila.<tailnet>.ts.net/ingest/text`).

### 1. Find your entities

In Home Assistant, **Settings** → **Devices & services** → **Entities**, and
note:

- your Alexa to-do list: `todo.<your account>_to_do_list`
- your phone, for failure notices: the `notify.mobile_app_<phone>` action
  (from the Companion app)

The examples below use `todo.alexa_to_do_list` and `notify.mobile_app_phone`;
replace both.

### 2. Give Home Assistant the pipeline's token

Add a line to Home Assistant's `secrets.yaml` with the pipeline's
`INGEST_API_TOKEN` from milaclone's `.env`, prefixed with `Bearer `:

```yaml
milaclone_ingest_bearer: 'Bearer <INGEST_API_TOKEN>'
```

`secrets.yaml` now holds a credential; keep it readable by Home Assistant only
(`chmod 600`).

### 3. Add the request and a reply switch

In `configuration.yaml`:

```yaml
rest_command:
  milaclone_ingest_text:
    url: http://127.0.0.1:8183/ingest/text
    method: POST
    headers:
      Authorization: !secret milaclone_ingest_bearer
    content_type: application/json
    payload: '{{ {"text": text, "source": "alexa"} | to_json }}'
    timeout: 60

input_boolean:
  milaclone_echo_reply:
    name: Milaclone reply on Echo
    icon: mdi:account-voice
```

The switch starts off. Turned on, the Echo that heard you also speaks
milaclone's own reply ("Added Buy printer ink.", "… is already on your list")
after Alexa's confirmation.

### 4. Add the automation

Settings → **Automations & scenes** → **Create automation** → **Create new
automation** → ⋮ → **Edit in YAML**, paste, replace the two entity names, save:

```yaml
alias: Milaclone from Alexa to-do list
description: >-
  Sends each new item on the Alexa to-do list to the milaclone pipeline, then
  removes it from the Alexa list. If the pipeline can't be reached, the item
  stays on the list and the phone is told.
mode: queued
max: 10
triggers:
  - trigger: state
    entity_id: todo.alexa_to_do_list
conditions:
  # Only when items were added, not when this automation removes them.
  - condition: template
    value_template: >-
      {{ trigger.to_state.state | int(0) > 0 and
         trigger.to_state.state | int(0) > trigger.from_state.state | int(0) }}
actions:
  - action: todo.get_items
    target:
      entity_id: todo.alexa_to_do_list
    data:
      status: needs_action
    response_variable: todo
  - repeat:
      for_each: "{{ todo['todo.alexa_to_do_list']['items'] }}"
      sequence:
        - variables:
            ingest: null
        - action: rest_command.milaclone_ingest_text
          data:
            text: '{{ repeat.item.summary }}'
          response_variable: ingest
          continue_on_error: true
        - if:
            - condition: template
              value_template: '{{ ingest is not none and ingest.status == 200 }}'
          then:
            # The pipeline has it now, and alerts on its own if it fails later.
            - action: todo.remove_item
              target:
                entity_id: todo.alexa_to_do_list
              data:
                item: '{{ repeat.item.uid }}'
            - if:
                - condition: state
                  entity_id: input_boolean.milaclone_echo_reply
                  state: 'on'
                - condition: template
                  value_template: '{{ ingest.content.speech is string }}'
              then:
                # Reply on the Echo that heard a voice command most recently.
                - variables:
                    heard_by: >-
                      {{ states.event | selectattr('entity_id', 'search', '_voice_event$')
                         | rejectattr('state', 'in', ['unknown', 'unavailable'])
                         | sort(attribute='state', reverse=true)
                         | map(attribute='entity_id') | first | default('') }}
                    speaker: >-
                      {{ (device_entities(device_id(heard_by)) if heard_by else [])
                         | select('match', 'notify\..*_speak$') | first | default('') }}
                - if:
                    - condition: template
                      value_template: "{{ speaker != '' }}"
                  then:
                    - action: notify.send_message
                      target:
                        entity_id: '{{ speaker }}'
                      data:
                        message: '{{ ingest.content.speech }}'
          else:
            - action: notify.mobile_app_phone
              data:
                title: Milaclone
                message: >-
                  "{{ repeat.item.summary }}" wasn't sent to milaclone
                  ({{ 'no answer' if ingest is none else 'HTTP ' ~ ingest.status }}).
                  It's still on your Alexa to-do list and will be retried when
                  you add the next item.
```

### 5. Try it

Say "Alexa, add buy test printer ink on Friday to my to-do list". Within a few
seconds the item leaves the Alexa list (in the Alexa app and in Home
Assistant's **To-do lists**) and _Buy test printer ink_, due Friday, is in the
Inbox with source `alexa`. Each capture also appears on the pipeline's review
page (`/ingest/review`).

## Good to know

- Say **"to my to-do list"**. "Alexa, add buy printer ink" on its own goes to
  the **shopping** list, which this automation doesn't watch. To capture both,
  copy the automation for `todo.<your account>_shopping_list`.
- Every open item on the Alexa to-do list is sent when something new arrives,
  including items that were there before you set this up. Clear the list first
  if you don't want those in milaclone.
- When the pipeline answers, the item is removed from Alexa's list even if
  extraction or the task API later fails; the pipeline records it, shows it on
  the review page and sends its own failure alert (`ALERT_WEBHOOK_URL`). Only
  when the pipeline can't be reached does the item stay on the Alexa list.
- A long or rambling item is fine: the pipeline can turn one sentence into
  several tasks.
- Changing the pipeline's `INGEST_API_TOKEN` means updating `secrets.yaml` and
  restarting Home Assistant.

## Troubleshooting

| Symptom                                           | Look at                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The item stays on the Alexa list, no notice       | The automation didn't run: Settings → Automations → **Milaclone from Alexa to-do list** → **Traces**. Check the to-do entity name, and that the list's count went up. |
| Phone says "wasn't sent to milaclone (no answer)" | The pipeline is down or unreachable from Home Assistant: `docker compose ps`, `docker compose logs pipeline`, and the URL in `rest_command`.                          |
| Phone says "… (HTTP 401)"                         | The token in `secrets.yaml` doesn't match `INGEST_API_TOKEN`, or the `Bearer ` prefix is missing.                                                                     |
| The item left the list but no task appeared       | The review page (`/ingest/review`): the transcript, what extraction found, and any error. "Already on your list" items are skipped on purpose.                        |
| Nothing reaches Home Assistant at all             | Alexa Devices needs signing in again (Settings → Devices & services), or Amazon changed something; check the integration's issues and Home Assistant's release notes. |

To switch it off, disable the automation. The pipeline keeps working for phone
voice notes.
