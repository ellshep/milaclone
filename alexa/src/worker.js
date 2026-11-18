// Cloudflare Worker: the public endpoint of the milaclone Alexa skill.
//
// "Alexa, tell my tasks to add buy printer ink" arrives here as a signed POST.
// The Worker checks it is from Alexa and from this skill, then sends the spoken
// text to the voice pipeline's POST /ingest/text through a Cloudflare Tunnel,
// and has Alexa read back what was added. It forwards to that one URL only.
//
// Settings (wrangler.toml vars and `wrangler secret put`):
//   SKILL_ID                 the skill's id (amzn1.ask.skill.…); others are refused
//   INGEST_URL               https://<tunnel hostname>/ingest/text
//   INGEST_API_TOKEN         secret: the pipeline's bearer token
//   CF_ACCESS_CLIENT_ID      secret: Cloudflare Access service token id
//   CF_ACCESS_CLIENT_SECRET  secret: Cloudflare Access service token secret
//   RATE_LIMITER             optional rate limit binding

import { verifyAlexaRequest, VerifyError } from './verify.js';

const INGEST_TIMEOUT_MS = 6500; // Alexa gives a skill about 8 seconds to answer
const TASK_MAX = 500;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json;charset=UTF-8' } });

function speak(text, { end = true, reprompt } = {}) {
  const response = { outputSpeech: { type: 'PlainText', text }, shouldEndSession: end };
  if (reprompt) response.reprompt = { outputSpeech: { type: 'PlainText', text: reprompt } };
  return json({ version: '1.0', response });
}

const log = (event, fields) => console.log(JSON.stringify({ event, ...fields }));

async function addTask(text, env, fetcher) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.INGEST_API_TOKEN };
  if (env.CF_ACCESS_CLIENT_ID) {
    headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET || '';
  }
  let res;
  try {
    res = await fetcher(env.INGEST_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, source: 'alexa' }),
      redirect: 'manual', // an Access login redirect is a failure, not a page to follow
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    });
  } catch (e) {
    log('ingest.unreachable', { error: String(e && e.name) });
    return "Sorry, I couldn't reach your task list, so that wasn't added.";
  }
  if (!res.ok) {
    log('ingest.error', { status: res.status });
    return "Sorry, your task list didn't accept that, so it wasn't added.";
  }
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  log('ingest.ok', { status: body && body.status, created: body && body.created && body.created.length });
  return (body && typeof body.speech === 'string' && body.speech) || "I sent that, but couldn't confirm it was added.";
}

async function handleAlexa(alexa, env, fetcher) {
  const req = alexa.request || {};
  if (req.type === 'LaunchRequest') {
    return speak('What should I add?', { end: false, reprompt: 'Say add, then the task.' });
  }
  if (req.type === 'SessionEndedRequest') return json({ version: '1.0', response: {} });
  if (req.type !== 'IntentRequest') return speak("Sorry, I can't do that.");

  const intent = req.intent || {};
  switch (intent.name) {
    case 'AddTaskIntent': {
      const said = (intent.slots && intent.slots.task && intent.slots.task.value) || '';
      const text = said.trim().slice(0, TASK_MAX);
      if (!text) return speak('What should I add?', { end: false, reprompt: 'Say add, then the task.' });
      return speak(await addTask(text, env, fetcher));
    }
    case 'AMAZON.HelpIntent':
      return speak('Say add, then the task. For example: add buy printer ink tomorrow. What should I add?', {
        end: false,
        reprompt: 'What should I add?',
      });
    case 'AMAZON.CancelIntent':
    case 'AMAZON.StopIntent':
    case 'AMAZON.NavigateHomeIntent':
      return speak('Okay.');
    default:
      return speak("Sorry, I didn't catch a task. Say add, then the task.", {
        end: false,
        reprompt: 'What should I add?',
      });
  }
}

export async function handle(request, env, { fetcher = fetch, now } = {}) {
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  if (!env.SKILL_ID || !env.INGEST_URL || !env.INGEST_API_TOKEN) {
    return json({ error: 'worker is not configured' }, 503);
  }
  if (env.RATE_LIMITER) {
    const key = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.RATE_LIMITER.limit({ key });
    if (!success) return json({ error: 'too many requests' }, 429);
  }

  let alexa;
  try {
    alexa = await verifyAlexaRequest(request, { fetcher, now });
  } catch (e) {
    if (!(e instanceof VerifyError)) throw e;
    log('alexa.rejected', { reason: e.message });
    return json({ error: 'request is not a valid Alexa request' }, 400);
  }

  const appId = alexa?.context?.System?.application?.applicationId || alexa?.session?.application?.applicationId || '';
  if (appId !== env.SKILL_ID) {
    log('alexa.rejected', { reason: 'wrong skill id' });
    return json({ error: 'request is for another skill' }, 400);
  }
  return handleAlexa(alexa, env, fetcher);
}

export default {
  fetch: (request, env) => handle(request, env),
};
