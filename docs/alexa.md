# Alexa capture

"Alexa, tell my tasks to add buy printer ink" puts _Buy printer ink_ in
milaclone's Inbox, and Alexa answers "Added Buy printer ink."

```
 Echo ─► Alexa cloud ─► Cloudflare Worker (alexa/)
                          checks Alexa's signature, the skill ID, a rate limit
                          │ POST /ingest/text  (bearer token + Access service token)
                          ▼
            Cloudflare Access ─► Cloudflare Tunnel ─► cloudflared on the server
                                                        ▼
                                  pipeline:8000 /ingest/text  (docs/voice-capture.md)
                                                        ▼
                                           task API ─► Inbox
```

The spoken text goes through the same extraction and duplicate check as a
voice note, so "add call the dentist tomorrow" gets tomorrow's date, and a task
already on the list isn't added twice.

## Why this route

Alexa only talks to a public HTTPS endpoint, so something has to face the
internet. The options that were weighed:

| Route                                            | Verdict                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home Assistant's Alexa integration               | No. Without Home Assistant Cloud it needs Home Assistant itself exposed to the internet, a much bigger surface than one path.                                                               |
| AWS Lambda + tunnel                              | Works. Amazon guarantees only the skill can invoke the function, so there is less security code, but it adds a second vendor and still needs a tunnel to reach the server.                  |
| Lambda + Tailscale Funnel                        | No. The capture path would face the internet with only its token in front of it.                                                                                                            |
| **Cloudflare Worker + Cloudflare Tunnel** (used) | One vendor, free tier, nothing listens on the server (the tunnel dials out). The cost is that the Worker checks Alexa's signature itself; that code is in `alexa/src/verify.js` and tested. |

What is exposed, and what protects it:

- **The Worker** is public. It answers only POSTs that carry a valid Alexa
  signature (certificate from Amazon's bucket, in date, issued for
  `echo-api.amazon.com`, signature over the exact body, timestamp under 150
  seconds old) and your skill's ID. It is rate limited to 20 requests a minute
  per caller, and it can call exactly one URL.
- **The tunnel hostname** is public but serves one path, `/ingest/text`, and
  Cloudflare Access turns away every caller without the Worker's service
  token before the request reaches your server.
- **The pipeline** still demands its own bearer token.
- The rest of milaclone, the task API and Home Assistant stay Tailscale-only.

What leaves the house: Amazon hears the phrase (as with anything said to an
Echo), the text passes through Cloudflare, and the pipeline sends it to the LLM
provider you configured.

## Setup

You need the voice pipeline running first (`docs/voice-capture.md`), a domain
on your Cloudflare account, and an Amazon developer account that uses the
**same Amazon login as your Echo**. Menu names in the two consoles change now
and then; the fields are what matter.

### 1. Tunnel (Cloudflare dashboard + server)

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** →
   create a tunnel named `milaclone-alexa`, connector **cloudflared**. Copy
   the tunnel **token** (the long string after `--token` in the install
   command it shows).
2. On the server, add to `.env` next to `docker-compose.yml`:

   ```bash
   COMPOSE_PROFILES=alexa
   CLOUDFLARE_TUNNEL_TOKEN=<the token>
   ```

   then `scripts/deploy.sh --force` (or `docker compose up -d`). The dashboard
   should show the tunnel as healthy.

3. In the tunnel's **Public hostnames**, add one:
   - Subdomain `alexa-ingest`, your domain.
   - Path: `^/ingest/text$`
   - Service: `HTTP` → `pipeline:8000`

### 2. Lock the hostname (Cloudflare Access)

1. **Zero Trust** → **Access** → **Service credentials** → **Service tokens**
   → create `milaclone-alexa-worker`. Copy the **Client ID** and **Client
   Secret** now; the secret is shown once.
2. **Access** → **Applications** → add a **self-hosted** application for
   `alexa-ingest.<your domain>`, with one policy: action **Service Auth**,
   include **Service Token** = `milaclone-alexa-worker`.
3. Check it from any machine:

   ```bash
   # refused by Access (403, or a redirect to a login page)
   curl -si -X POST https://alexa-ingest.<your domain>/ingest/text | head -1
   # allowed through, then answered by the pipeline
   curl -s https://alexa-ingest.<your domain>/ingest/text \
     -H "CF-Access-Client-Id: <client id>" -H "CF-Access-Client-Secret: <client secret>" \
     -H "Authorization: Bearer $INGEST_API_TOKEN" -H 'Content-Type: application/json' \
     -d '{"text":"test from curl","source":"alexa"}'
   ```

### 3. Worker (your computer)

```bash
cd alexa
npm ci
# edit wrangler.toml: INGEST_URL = "https://alexa-ingest.<your domain>/ingest/text"
npx wrangler login
npx wrangler deploy                      # prints https://milaclone-alexa.<you>.workers.dev
npx wrangler secret put INGEST_API_TOKEN          # the pipeline's token from the server's .env
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
```

Until the skill ID is set (next step) the Worker answers 503 to everything.

### 4. Skill (Alexa developer console)

1. <https://developer.amazon.com/alexa/console/ask> → **Create Skill**. Name
   `My Tasks`, your Echo's language, experience **Other**, model **Custom**,
   hosting **Provision your own**, template **Start from Scratch**.
2. **Interaction Model** → **JSON Editor**: paste
   `alexa/skill/interaction-model.json`, **Save**, then **Build**. The
   invocation name is `my tasks`; change it there if you want another.
3. **Endpoint** → **HTTPS**. Default Region: the Worker URL. Certificate type:
   **My development endpoint is a sub-domain of a domain that has a wildcard
   certificate from a certificate authority**. Save.
4. Copy **Your Skill ID** (`amzn1.ask.skill.…`) from the Endpoint page into
   `SKILL_ID` in `alexa/wrangler.toml`, then `npx wrangler deploy` again.
5. **Test** tab → set skill testing to **Development**. That makes the skill
   work on every Echo signed in to this Amazon account. Don't publish it; a
   development skill stays private to you.

### 5. Try it

- "Alexa, tell my tasks to add buy printer ink"
- "Alexa, ask my tasks to remind me to call the dentist tomorrow"
- "Alexa, open my tasks" → "What should I add?" → "add renew the car registration"

The Test tab's simulator takes the same phrases typed, and shows the JSON going
each way. Each capture also appears on the pipeline's review page
(`/ingest/review`) with source `alexa`.

## Good to know

- Alexa needs a lead-in word before the task ("add …", "remind me to …", "I
  need to …"); the free-text part can't stand alone. Add more phrasings to
  `samples` in the interaction model and rebuild.
- Alexa waits about 8 seconds. The Worker gives the pipeline 6.5; if the LLM is
  slower than that, Alexa says it couldn't reach the list, and the capture may
  still finish. Check the review page before repeating it.
- When something fails, Alexa says the task wasn't added. It never claims a
  task was added unless the pipeline said so.
- Changing the pipeline's `INGEST_API_TOKEN` means running
  `npx wrangler secret put INGEST_API_TOKEN` again.

## Troubleshooting

`npx wrangler tail` (in `alexa/`) shows the Worker's log live.

| Symptom                                                   | Look at                                                                                                                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "There was a problem with the requested skill's response" | `wrangler tail`. `alexa.rejected … wrong skill id` → `SKILL_ID` in `wrangler.toml` doesn't match; redeploy. A 503 → a var or secret is missing.                                               |
| "Sorry, I couldn't reach your task list"                  | The tunnel or pipeline is down or slow: `docker compose ps`, `docker compose logs cloudflared pipeline`, tunnel health in the dashboard.                                                      |
| "Your task list didn't accept that"                       | `ingest.error` status in `wrangler tail`: 401 → wrong `INGEST_API_TOKEN` secret; 302/403 → Access service token secrets wrong or policy missing; 404 → the tunnel's path or service is wrong. |
| Alexa doesn't know the skill                              | Testing isn't set to Development, or the Echo is on a different Amazon account or language than the skill.                                                                                    |
| "I didn't hear any tasks in that"                         | The pipeline found no action item in the text; see the transcript on the review page.                                                                                                         |

To switch Alexa capture off: disable the skill's testing, or remove
`COMPOSE_PROFILES=alexa` and run `docker compose up -d --remove-orphans` to
stop the tunnel.
